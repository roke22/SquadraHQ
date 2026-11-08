// What core asks of the agent it runs under. The entry point fills it in, before
// anything can arrive:
//   deliver({ content, meta })       put a message or a notice in front of it
//   takePermissionReply(msg, match)  a "yes abcde" from another session: the
//                                    verdict, null to drop it, 'chat' if it isn't one
//   givePermission(verdict)          hand it that answer
//   kind                             which agent it is: 'claude', 'codex' or 'grok'
//   waiting()                        (optional) how many messages wait to be put
//                                    in front of it (an agent without channels
//                                    gets them only between its turns)
export const agent = {}

export function useAgent(a) {
  Object.assign(agent, a)
}
