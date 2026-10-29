import {goalOperations} from './goal-operations.mjs';
export default {
 id:'claude-code',
 // Reception after a response uses the watcher hook; setup has no extra option.
 async setupOptions(){return [];},
 guidance:{
  operations:{
   ...goalOperations,
   join:{command:'agent join',confirmation:'When agent show reports no connection, run it once. It connects this conversation at once; resuming is not needed.'},
   wait:{command:'agent wait',confirmation:'Start it as a Claude background task only when a result asks for it: in Claude Desktop it keeps the conversation from being paused so the watcher hook can wake it.'}
  },
  activation:{
   beforeCreate:'Run agent show before createRoot. If it reports no connection, run agent join. Do not fabricate identity variables.',
   whenUserActionNeeded:'If native Hook review is pending, explain it first. A missing SessionStart is not a user action: connect with agent join. Open the workspace Web before asking them to act; do not claim a Goal or return path exists yet.',
   userMessage:'The Web page is ready. To receive its replies here, Claude needs to load the connection settings. {observedReviewAction} Then I will connect this conversation and prepare your Goal.',
   confirmation:'Verify agent show, after agent join when needed, then create the Root. Reuse a Root already owned by this session AND context. Do not clear, fork, launch another receiver or change permissions.'
  },
  nextActions:[
   'For first use, follow onboarding in order, including opening Web; activation below owns the native prerequisites.',
   'Use the actual native project directory. A linked Git worktree shares its main checkout\'s project, Web and local settings. Do not substitute the skill installation directory.',
   'Review native Hooks when required. If agent show reports no connection, run agent join; resuming is not needed. Do not clear, fork, fabricate identity variables or launch a second writer.',
   'Before ending a response that waits for something outside chill (CI, a build), schedule a check with agent wake --in <minutes> --reason <text>; finished CI wakes nobody, and the watcher wakes this conversation at that time.',
   'There is no deferred Queue state. Keep independent input in the current work plan; select the Goal being worked on with goal work. Saved Web feedback reaches the conversation through its hooks: during work at the next tool call, and when idle through the watcher hook.',
   'Children, Deliverables, replies and ordinary reads use the shared goal commands.',
   'A Web comment that starts with /name asks you to use that skill. If it is not loaded by name, read its SKILL.md in .claude/skills, .agents/skills or .codex/skills of the project or home folder.',
   'Other conversations may work in the same project at the same time, often in other Git worktrees; each owns its own Root. Work only on Goals under your own Root and change only your own working folder. Read other Roots only when the user asks.'
  ],
  constraints:[
   'Setup preserves native permissions, other Hooks and disablement; it never raises the Autonomy of a Goal.',
   'Reception after a response needs the original conversation open; the watcher hook wakes it. A closed Claude process receives nothing until it is opened again.',
   'Pause from the Web refuses the next tool call and holds new feedback and continuation until Resume. Model settings, usage and cancellation remain native controls.'
  ]
 }
};
