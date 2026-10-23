export default {
 id:'claude-code',
 // Reception after a response uses the watcher hook; setup has no extra option.
 async setupOptions(){return [];},
 guidance:{
  operations:{
   inspect:{command:'connection show',confirmation:'Shows this conversation\'s connection and the Roots it owns.'},
   join:{command:'connection join',confirmation:'When connection show reports no connection, run it once. It connects this conversation at once; resuming is not needed.'},
   createRoot:{command:'connection create-goal --help',confirmation:'Creates the Root in this conversation at once and prints its ID.'},
   selectWork:{command:'goal work --id <GOAL>',confirmation:'Marks the Goal this response works on for the Web until the response ends. A reply does not select work or complete the Goal.'},
   adopt:{command:'connection adopt --goal <ID>',confirmation:'Only when the user asks this conversation to continue a Goal owned by an earlier conversation (for example after Claude continued the chat in a new session).'},
   inbox:{command:'connection inbox',confirmation:'Hands any feedback that waits and lists the handed comments whose Goals still wait for a reply. Hooks hand new feedback on their own; read it when you need to recover input.'},
   reply:{command:'connection reply --goal <GOAL> --text <TEXT>',confirmation:'Posts the answer on the Goal at once. A Goal waits for a reply while the user commented after the agent; one reply answers all of it.'},
   wait:{command:'connection wait',confirmation:'Start it as a Claude background task only when a connection result asks for it: in Claude Desktop it keeps the conversation from being paused so the watcher hook can wake it; without the hook it is the reply waiter.'}
  },
  activation:{
   beforeCreate:'Run connection show before createRoot. If it reports no connection, run connection join. Missing identity cannot be replaced with an ordinary goal create, fabricated environment variables or a Codex route.',
   whenUserActionNeeded:'If native Hook review is pending, explain it first. A missing SessionStart is not a user action: connect with connection join. Open the workspace Web before asking them to act; do not claim a Goal or return path exists yet.',
   userMessage:'The Web page is ready. To receive its replies here, Claude needs to load the connection settings. {observedReviewAction} Then I will connect this conversation and prepare your Goal.',
   confirmation:'Verify connection show, after connection join when needed, then create the Root. Reuse a Root already owned by this session AND context. Do not clear, fork, launch another receiver or change permissions.'
  },
  nextActions:[
   'For first use, follow onboarding in order, including opening Web; activation below owns the native prerequisites.',
   'Use the actual native project directory. A linked Git worktree shares its main checkout\'s project, Web and local settings. Do not substitute the skill installation directory.',
   'Review native Hooks when required. If connection show reports no connection, run connection join; resuming is not needed. Do not clear, fork, fabricate identity variables or launch a second writer.',
   'Before ending a response that waits for something outside chill (CI, a build), schedule a check with connection wake --in <minutes> --reason <text>; finished CI wakes nobody, and the watcher wakes this conversation at that time.',
   'There is no deferred Queue state. Keep independent input in the current work plan; select the Goal being worked on with goal work. Saved Web feedback reaches the conversation through its hooks: during work at the next tool call, and when idle through the watcher hook.',
   'Children, Deliverables, Comments, Letters and ordinary reads use the shared goal commands. Existing Root connections cannot be reassigned.',
   'A Web comment that starts with /name asks you to use that skill. If it is not loaded by name, read its SKILL.md in .claude/skills, .agents/skills or .codex/skills of the project or home folder.',
   'Other conversations may work in the same project at the same time, often in other Git worktrees; each owns its own Root. Work only on Goals under your own Root and change only your own working folder. Read other Roots only when the user asks.'
  ],
  constraints:[
   'Setup preserves native permissions, other Hooks and disablement; it never enables Auto mode.',
   'Reception after a response needs the original conversation open; the watcher hook wakes it. A closed Claude process receives nothing until it is opened again.',
   'Pause from the Web refuses the next tool call and holds new feedback and continuation until Resume. Model settings, usage and cancellation remain native controls.'
  ]
 }
};
