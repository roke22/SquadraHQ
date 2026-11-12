// A GitHub that answers the GraphQL calls of server/boards/github.js, by their
// names, from memory: one project with its fields and items, issues with
// labels, sub-issues and comments. Like GitHub at its worst, replacing a
// field's options gives them new ids and leaves the items without a value.
// What a person does on github.com is done with the helpers it returns.

import { createServer } from 'node:http'

export async function startFakeGithub({ token = 'ghp_test_token_0123456789' } = {}) {
  let n = 0
  const id = prefix => `${prefix}_${++n}`
  const at = () => new Date(Date.now() + n).toISOString() // (always later than the last)
  const calls = []
  const repo = { id: 'R_1', name: 'acme/web', labels: [{ id: id('LA'), name: 'bug' }] }
  const issues = new Map()
  const drafts = new Map()
  let issueNumber = 0
  const status = { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: ['Todo', 'In Progress', 'Done'].map(name => ({ id: id('O'), name, color: 'GRAY' })) }
  const project = { id: 'P_1', title: 'Web launch', url: 'https://github.com/orgs/acme/projects/3', fields: [{ id: 'F_title', name: 'Title', dataType: 'TITLE' }, status], items: [] }

  const touch = item => { item.updatedAt = at() }
  const itemOf = itemId => project.items.find(i => i.id === itemId)
  const itemFor = contentId => project.items.find(i => i.content === contentId)
  function issueView(i, withComments) {
    return {
      __typename: 'Issue', id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, stateReason: i.stateReason, updatedAt: i.updatedAt, url: `https://github.com/acme/web/issues/${i.number}`,
      repository: { nameWithOwner: repo.name }, labels: { nodes: i.labels.map(l => repo.labels.find(x => x.id === l)).filter(Boolean) },
      parent: i.parent ? { id: i.parent } : null,
      ...(withComments ? { comments: { nodes: i.comments.slice(-50).map(c => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: { login: c.login } })) } } : {}),
    }
  }
  function itemView(it, withComments = false) {
    const content = issues.has(it.content) ? issueView(issues.get(it.content), withComments) : { __typename: 'DraftIssue', ...drafts.get(it.content) }
    return {
      id: it.id, isArchived: false, updatedAt: it.updatedAt, type: content.__typename === 'Issue' ? 'ISSUE' : 'DRAFT_ISSUE',
      fieldValues: { nodes: [...it.values].map(([fieldId, optionId]) => ({ optionId, field: { id: fieldId } })) },
      content,
    }
  }
  const selectFields = () => project.fields.filter(f => f.options)

  const ops = {
    Project: v => {
      const p = v.owner === 'acme' && v.number === 3 ? { id: project.id, title: project.title, url: project.url, fields: { nodes: project.fields } } : null
      return { organization: { projectV2: p }, user: { projectV2: p } }
    },
    Repository: v => ({ repository: `${v.owner}/${v.name}` === repo.name ? { id: repo.id, nameWithOwner: repo.name, labels: { nodes: repo.labels } } : null }),
    Items: v => {
      const start = v.after ? Number(v.after) : 0
      const page = project.items.slice(start, start + 2) // (small pages: paging is tested too)
      return { node: { items: { pageInfo: { hasNextPage: start + 2 < project.items.length, endCursor: String(start + 2) }, nodes: page.map(itemView) } } }
    },
    Item: v => ({ node: itemOf(v.id) ? itemView(itemOf(v.id), true) : null }),
    CreateField: ({ input }) => {
      // (GitHub keeps some names for its own fields, not all of them listed.)
      if (['type', 'labels', 'assignees', 'milestone', 'repository', 'reviewers', 'parent issue', 'sub-issues progress', 'linked pull requests'].includes(input.name.toLowerCase())) throw new Error('Name cannot have a reserved value, Name has already been taken')
      const f = { id: id('F'), name: input.name, dataType: 'SINGLE_SELECT', options: input.singleSelectOptions.map(o => ({ id: id('O'), name: o.name, color: o.color })) }
      project.fields.push(f)
      return { createProjectV2Field: { projectV2Field: f } }
    },
    SetOptions: ({ input }) => {
      const f = project.fields.find(x => x.id === input.fieldId)
      f.options = input.singleSelectOptions.map(o => ({ id: id('O'), name: o.name, color: o.color }))
      for (const it of project.items) it.values.delete(f.id) // (the worst case)
      return { updateProjectV2Field: { projectV2Field: f } }
    },
    SetSelect: ({ input }) => {
      const it = itemOf(input.itemId)
      const f = project.fields.find(x => x.id === input.fieldId)
      if (!f.options.some(o => o.id === input.value.singleSelectOptionId)) throw new Error('no such option')
      it.values.set(f.id, input.value.singleSelectOptionId); touch(it)
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: it.id } } }
    },
    ClearSelect: ({ input }) => { const it = itemOf(input.itemId); it.values.delete(input.fieldId); touch(it); return { clearProjectV2ItemFieldValue: { projectV2Item: { id: it.id } } } },
    CreateIssue: ({ input }) => {
      const i = { id: id('I'), number: ++issueNumber, title: input.title, body: input.body ?? '', state: 'OPEN', stateReason: null, labels: input.labelIds ?? [], parent: input.parentIssueId ?? null, comments: [], updatedAt: at() }
      issues.set(i.id, i)
      // (As GitHub does: a sub-issue goes into its parent's project by itself.)
      if (i.parent && itemFor(i.parent)) project.items.push({ id: id('PVTI'), content: i.id, values: new Map(), updatedAt: at() })
      return { createIssue: { issue: { id: i.id, number: i.number, url: `https://github.com/acme/web/issues/${i.number}`, updatedAt: i.updatedAt } } }
    },
    AddItem: ({ input }) => {
      if (!issues.has(input.contentId) && !drafts.has(input.contentId)) throw Object.assign(new Error(`Could not resolve to a node with the global id of '${input.contentId}'.`), { type: 'NOT_FOUND' })
      if (itemFor(input.contentId)) throw new Error('Content already exists in this project')
      const it = { id: id('PVTI'), content: input.contentId, values: new Map(), updatedAt: at() }
      project.items.push(it)
      return { addProjectV2ItemById: { item: { id: it.id } } }
    },
    ItemOf: v => ({ node: issues.has(v.id) ? { projectItems: { nodes: project.items.filter(i => i.content === v.id).map(i => ({ id: i.id, project: { id: project.id } })) } } : null }),
    RemoveItem: ({ input }) => { project.items = project.items.filter(i => i.id !== input.itemId); return { deleteProjectV2Item: { deletedItemId: input.itemId } } },
    UpdateIssue: ({ input }) => {
      const i = issues.get(input.id)
      for (const k of ['title', 'body']) if (input[k] !== undefined) i[k] = input[k]
      if (input.labelIds) i.labels = input.labelIds
      i.updatedAt = at()
      return { updateIssue: { issue: { id: i.id } } }
    },
    UpdateDraft: ({ input }) => { const d = drafts.get(input.draftIssueId); Object.assign(d, { title: input.title ?? d.title, body: input.body ?? d.body, updatedAt: at() }); return { updateProjectV2DraftIssue: { draftIssue: { id: d.id } } } },
    CloseIssue: ({ input }) => { const i = issues.get(input.issueId); Object.assign(i, { state: 'CLOSED', stateReason: input.stateReason ?? 'COMPLETED', updatedAt: at() }); return { closeIssue: { issue: { id: i.id } } } },
    ReopenIssue: ({ input }) => { const i = issues.get(input.issueId); Object.assign(i, { state: 'OPEN', stateReason: 'REOPENED', updatedAt: at() }); return { reopenIssue: { issue: { id: i.id } } } },
    AddSubIssue: ({ input }) => { const i = issues.get(input.subIssueId); i.parent = input.issueId; i.updatedAt = at(); return { addSubIssue: { issue: { id: input.issueId } } } },
    RemoveSubIssue: ({ input }) => { const i = issues.get(input.subIssueId); i.parent = null; i.updatedAt = at(); return { removeSubIssue: { issue: { id: input.issueId } } } },
    AddComment: ({ input }) => {
      const c = { id: id('IC'), body: input.body, createdAt: at(), login: 'squadra-bot' }
      issues.get(input.subjectId).comments.push(c)
      return { addComment: { commentEdge: { node: { id: c.id } } } }
    },
    CreateLabel: ({ input }) => { const l = { id: id('LA'), name: input.name }; repo.labels.push(l); return { createLabel: { label: l } } },
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
      if (req.headers.authorization !== `bearer ${token}`) return send(401, { message: 'Bad credentials' })
      const { operationName, variables } = JSON.parse(body)
      calls.push(operationName)
      const op = ops[operationName]
      if (!op) return send(200, { errors: [{ message: `unknown operation ${operationName}` }] })
      try { send(200, { data: op(variables ?? {}) }) } catch (err) { send(200, { errors: [{ message: err.message, ...(err.type ? { type: err.type } : {}) }] }) }
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/graphql`

  // What a person does on github.com.
  const optionOf = (field, name) => field.options.find(o => o.name === name)?.id
  const fieldNamed = name => project.fields.find(f => f.name === name)
  const person = {
    addIssue({ title, body = '', status: s, labels = [] }) {
      const i = { id: id('I'), number: ++issueNumber, title, body, state: 'OPEN', stateReason: null, labels: labels.map(name => repo.labels.find(l => l.name === name)?.id ?? (repo.labels.push({ id: id('LA'), name }), repo.labels.at(-1).id)), parent: null, comments: [], updatedAt: at() }
      issues.set(i.id, i)
      const it = { id: id('PVTI'), content: i.id, values: new Map(), updatedAt: at() }
      if (s) it.values.set(status.id, optionOf(status, s))
      project.items.push(it)
      return i
    },
    addDraft({ title, body = '' }) {
      const d = { id: id('DI'), title, body, updatedAt: at() }
      drafts.set(d.id, d)
      project.items.push({ id: id('PVTI'), content: d.id, values: new Map(), updatedAt: at() })
      return d
    },
    setStatus(issueId, name) { const it = itemFor(issueId); it.values.set(status.id, optionOf(status, name)); touch(it) },
    setField(issueId, fieldName, value) { const it = itemFor(issueId); const f = fieldNamed(fieldName); if (value == null) it.values.delete(f.id); else it.values.set(f.id, optionOf(f, value)); touch(it) },
    edit(issueId, patch) { Object.assign(issues.get(issueId), patch, { updatedAt: at() }) },
    close(issueId, reason = 'COMPLETED') { Object.assign(issues.get(issueId), { state: 'CLOSED', stateReason: reason, updatedAt: at() }) },
    comment(issueId, body, login = 'octocat') { issues.get(issueId).comments.push({ id: id('IC'), body, createdAt: at(), login }); issues.get(issueId).updatedAt = at() },
    setParent(issueId, parentId) { issues.get(issueId).parent = parentId; issues.get(issueId).updatedAt = at() },
    deleteIssue(issueId) { issues.delete(issueId); project.items = project.items.filter(i => i.content !== issueId) },
    removeFromProject(issueId) { project.items = project.items.filter(i => i.content !== issueId) },
    addToProject(issueId) { project.items.push({ id: id('PVTI'), content: issueId, values: new Map(), updatedAt: at() }) },
    renameOption(name, to) { status.options.find(o => o.name === name).name = to },
    addOption(name) { status.options.push({ id: id('O'), name, color: 'GRAY' }) },
  }
  const look = {
    issues: () => [...issues.values()],
    issue: title => [...issues.values()].find(i => i.title === title),
    statusOf: issueId => { const it = itemFor(issueId); return status.options.find(o => o.id === it?.values.get(status.id))?.name ?? null },
    fieldOf: (issueId, fieldName) => { const it = itemFor(issueId); const f = fieldNamed(fieldName); return f?.options.find(o => o.id === it?.values.get(f.id))?.name ?? null },
    field: fieldNamed, inProject: issueId => !!itemFor(issueId), labelsOf: issueId => issues.get(issueId).labels.map(l => repo.labels.find(x => x.id === l)?.name),
    options: () => status.options.map(o => o.name),
  }
  return { url, token, calls, person, look, stop: () => new Promise(r => server.close(r)) }
}
