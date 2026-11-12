// GitHub's GraphQL API, as the boards use it: a project (Projects v2) with its
// Status, Agent and Type fields, its items and their issues, sub-issues and
// comments. Only what the sync needs; every call is named, so a test can
// answer it (SQUADRA_GITHUB_API points elsewhere).

const API = () => process.env.SQUADRA_GITHUB_API || 'https://api.github.com/graphql'

export class GithubError extends Error {
  constructor(message, { status = 0, auth = false, notFound = false, transient = false } = {}) { super(message); Object.assign(this, { status, auth, notFound, transient }) }
}

// "https://github.com/orgs/acme/projects/3", "github.com/users/ana/projects/1/views/2"
export function parseProjectUrl(url) {
  const m = /^(?:https?:\/\/)?github\.com\/(orgs|users)\/([A-Za-z0-9-]{1,39})\/projects\/(\d{1,9})(?:[/?#].*)?$/.exec(String(url ?? '').trim())
  return m ? { ownerKind: m[1] === 'orgs' ? 'org' : 'user', owner: m[2], number: Number(m[3]) } : null
}
export function parseRepo(text) {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\.git)?\/?$/.exec(String(text ?? '').trim())
  return m ? { owner: m[1], name: m[2] } : null
}

const FIELDS = `fields(first: 50) { nodes {
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color } } } }`

// (The whole board is read without comments: a task's come when it is opened.)
const ISSUE = `id number title body state stateReason updatedAt url
  repository { nameWithOwner }
  labels(first: 30) { nodes { id name } }
  parent { id }`
const COMMENTS = 'comments(last: 50) { nodes { id body createdAt author { login } } }'

const ITEM = (withComments = false) => `id isArchived updatedAt type
  fieldValues(first: 30) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } } } }
  content { __typename ... on Issue { ${ISSUE} ${withComments ? COMMENTS : ''} } ... on DraftIssue { id title body updatedAt } }`

const ITEMS = `items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${ITEM()} } }`

const PROJECT = kind => `query Project($owner: String!, $number: Int!) {
  ${kind === 'org' ? 'organization' : 'user'}(login: $owner) { projectV2(number: $number) { id title url ${FIELDS} } } }`

export function githubClient(token) {
  async function gql(name, query, variables = {}) {
    let r
    try {
      r = await fetch(API(), {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'SquadraHQ', 'GraphQL-Features': 'sub_issues' },
        body: JSON.stringify({ operationName: name, query, variables }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) { throw new GithubError(`GitHub could not be reached: ${err.message}`, { transient: true }) }
    if (r.status === 401) throw new GithubError('GitHub refused the token (401): it is wrong, expired or revoked', { status: 401, auth: true })
    const j = await r.json().catch(() => null)
    if (r.status === 403 || r.status === 429) throw new GithubError(`GitHub said no (${r.status}): ${j?.message ?? 'rate limited or not allowed'}`, { status: r.status, auth: r.status === 403 && r.headers.get('x-ratelimit-remaining') !== '0', transient: r.status === 429 || r.headers.get('x-ratelimit-remaining') === '0' })
    if (!r.ok || !j) throw new GithubError(`GitHub answered ${r.status}`, { status: r.status, transient: r.status >= 500 })
    if (j.errors?.length) {
      const msg = j.errors.map(e => e.message).join('; ')
      throw new GithubError(`GitHub: ${msg}`, { auth: j.errors.some(e => ['FORBIDDEN', 'INSUFFICIENT_SCOPES'].includes(e.type)), notFound: j.errors.every(e => e.type === 'NOT_FOUND') })
    }
    return j.data
  }

  return {
    async project({ ownerKind, owner, number }) {
      const d = await gql('Project', PROJECT(ownerKind), { owner, number })
      const p = (ownerKind === 'org' ? d.organization : d.user)?.projectV2
      if (!p) throw new GithubError(`no project ${number} of ${owner} that this token can see`)
      return { id: p.id, title: p.title, url: p.url, fields: p.fields.nodes.filter(f => f?.id) }
    },
    async repository({ owner, name }) {
      const d = await gql('Repository', `query Repository($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { id nameWithOwner labels(first: 100) { nodes { id name } } } }`, { owner, name })
      if (!d.repository) throw new GithubError(`no repository ${owner}/${name} that this token can see`)
      return { id: d.repository.id, name: d.repository.nameWithOwner, labels: d.repository.labels.nodes }
    },
    // Every item of the project, page by page.
    async items(projectId) {
      const out = []
      let after = null
      for (let page = 0; page < 60; page++) {
        const d = await gql('Items', `query Items($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { ${ITEMS} } } }`, { id: projectId, after })
        const items = d.node?.items
        if (!items) throw new GithubError('the project is gone, or this token no longer sees it')
        out.push(...items.nodes.filter(Boolean))
        if (!items.pageInfo.hasNextPage) return out
        after = items.pageInfo.endCursor
      }
      return out
    },
    // One item, with its issue's comments; null if it is no longer in the project.
    async item(itemId) {
      try {
        const d = await gql('Item', `query Item($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM(true)} } } }`, { id: itemId })
        return d.node?.id ? d.node : null
      } catch (err) { if (err.notFound) return null; throw err }
    },
    async createField(projectId, name, options) {
      const d = await gql('CreateField', `mutation CreateField($input: CreateProjectV2FieldInput!) {
        createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color } } } } }`,
      { input: { projectId, dataType: 'SINGLE_SELECT', name, singleSelectOptions: options } })
      return d.createProjectV2Field.projectV2Field
    },
    // (GitHub replaces the options, with new ids: what the items had is put back by the caller.)
    async setOptions(fieldId, options) {
      const d = await gql('SetOptions', `mutation SetOptions($input: UpdateProjectV2FieldInput!) {
        updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color } } } } }`,
      { input: { fieldId, singleSelectOptions: options } })
      return d.updateProjectV2Field.projectV2Field
    },
    async setSelect(projectId, itemId, fieldId, optionId) {
      if (optionId) {
        await gql('SetSelect', `mutation SetSelect($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }`,
          { input: { projectId, itemId, fieldId, value: { singleSelectOptionId: optionId } } })
      } else {
        await gql('ClearSelect', `mutation ClearSelect($input: ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }`,
          { input: { projectId, itemId, fieldId } })
      }
    },
    async createIssue({ repositoryId, title, body, labelIds, parentIssueId }) {
      const d = await gql('CreateIssue', `mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { id number url updatedAt } } }`,
        { input: { repositoryId, title, body, labelIds, ...(parentIssueId ? { parentIssueId } : {}) } })
      return d.createIssue.issue
    },
    async addItem(projectId, contentId) {
      const d = await gql('AddItem', `mutation AddItem($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`, { input: { projectId, contentId } })
      return d.addProjectV2ItemById.item.id
    },
    async removeItem(projectId, itemId) {
      await gql('RemoveItem', `mutation RemoveItem($input: DeleteProjectV2ItemInput!) { deleteProjectV2Item(input: $input) { deletedItemId } }`, { input: { projectId, itemId } })
    },
    async updateIssue(id, patch) {
      await gql('UpdateIssue', `mutation UpdateIssue($input: UpdateIssueInput!) { updateIssue(input: $input) { issue { id } } }`, { input: { id, ...patch } })
    },
    async updateDraft(draftIssueId, patch) {
      await gql('UpdateDraft', `mutation UpdateDraft($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id } } }`, { input: { draftIssueId, ...patch } })
    },
    async closeIssue(issueId, stateReason) {
      await gql('CloseIssue', `mutation CloseIssue($input: CloseIssueInput!) { closeIssue(input: $input) { issue { id } } }`, { input: { issueId, stateReason } })
    },
    async reopenIssue(issueId) {
      await gql('ReopenIssue', `mutation ReopenIssue($input: ReopenIssueInput!) { reopenIssue(input: $input) { issue { id } } }`, { input: { issueId } })
    },
    async setParent(issueId, subIssueId) {
      await gql('AddSubIssue', `mutation AddSubIssue($input: AddSubIssueInput!) { addSubIssue(input: $input) { issue { id } } }`, { input: { issueId, subIssueId, replaceParent: true } })
    },
    async removeParent(issueId, subIssueId) {
      await gql('RemoveSubIssue', `mutation RemoveSubIssue($input: RemoveSubIssueInput!) { removeSubIssue(input: $input) { issue { id } } }`, { input: { issueId, subIssueId } })
    },
    async comment(subjectId, body) {
      const d = await gql('AddComment', `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`, { input: { subjectId, body } })
      return d.addComment.commentEdge.node.id
    },
    async createLabel(repositoryId, name, color) {
      const d = await gql('CreateLabel', `mutation CreateLabel($input: CreateLabelInput!) { createLabel(input: $input) { label { id name } } }`, { input: { repositoryId, name, color } })
      return d.createLabel.label
    },
  }
}
