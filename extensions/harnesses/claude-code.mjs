export default {
 id:'claude-code',
 // Reception after a response uses the CLI's reply waiter; setup has no extra option.
 async setupOptions(){return [];},
 guidance:{
  operations:{
   inspect:{command:'connection show',confirmation:'Run through the main Bash tool. Verify the identity handoff; existing Root session AND context must match.'},
   join:{command:'connection join',confirmation:'When connection show reports no connection, run it once through the main Bash tool. Only its main PostToolUse confirmation connects this conversation; resuming is not needed.'},
   createRoot:{command:'connection create-goal --help',confirmation:'A request marker is pending. Only main PostToolUse confirmation establishes the saved Root.'},
   receipt:{command:'goal activity --event <ID> --state <STATE>',states:['working','completed','failed'],confirmation:'Use separate main Bash calls and preserve stdout. Wait for main-hook confirmation; inspect connection request --id <ID> for uncertain results before any retry.'},
   selectWork:{command:'goal work --id <GOAL>',confirmation:'Marks the Goal this response works on for the Web until the response ends. A receipt does not select work or complete the Goal.'},
   adopt:{command:'connection adopt --goal <ID>',confirmation:'Only when the user asks this conversation to continue a Goal owned by an earlier conversation (for example after Claude continued the chat in a new session). Wait for the main PostToolUse confirmation; refused while the owner still waits for Web replies.'},
   inbox:{command:'connection inbox',confirmation:'Recover pending input or establish a verified prompt through the main hook before expecting ordinary tool hooks to receive input.'},
   reply:{command:'connection reply --event <ID>[,<ID>…] --text <TEXT>',confirmation:'Posts the Web answer and records the completed receipt in one main-hook confirmation; a retry of the same request does not post twice. Several IDs of one Goal may share one reply when that answers them together.'},
   wait:{command:'connection wait',confirmation:'Start it as a Claude background task (Bash run_in_background) whenever a connection result asks for it. It exits when Web feedback is saved, which wakes an idle conversation; then read connection inbox and start it again.'}
  },
  activation:{
   beforeCreate:'Run connection show through the main Bash tool before createRoot. If it reports no connection, run connection join through the main Bash tool and wait for its confirmation. Missing identity cannot be replaced with an ordinary goal create, fabricated environment variables or a Codex route.',
   whenUserActionNeeded:'If native Hook review is pending, explain it first. A missing SessionStart is not a user action: connect with connection join. Open the workspace Web before asking them to act; do not claim a Goal or return path exists yet.',
   userMessage:'The Web page is ready. To receive its replies here, Claude needs to load the connection settings. {observedReviewAction} Then I will connect this conversation and prepare your Goal.',
   confirmation:'Verify connection show, after connection join when needed, and the main PostToolUse confirmation of Root creation. Reuse a Root already owned by this session AND context. Do not clear, fork, launch another receiver or change permissions.'
  },
  nextActions:[
   'For first use, follow onboarding in order, including opening Web; activation below owns the native prerequisites.',
   'Use the actual native project directory. A linked Git worktree shares its main checkout\'s project, Web and local settings. Do not substitute the skill installation directory.',
   'Review native Hooks when required. If connection show reports no connection, run connection join; resuming is not needed. Do not clear, fork, fabricate identity variables or launch a second writer.',
   'Run connection show from main Bash to verify the handoff before creating a Root. Run each connection action separately; a shell receipt alone is not confirmation.',
   'Before ending a response that waits for something outside chill (CI, a build), schedule a check with connection wake --in <minutes> --reason <text>; finished CI wakes nobody, and the reply waiter ends at that time to wake this conversation.',
   'There is no deferred Queue state. Keep independent input in the current work plan; select the Goal being worked on with goal work. Saved Web feedback wakes an idle conversation only while the reply waiter runs; follow the connection results that ask to start it.',
   'Children, Deliverables, Comments, Letters and ordinary reads use the shared goal commands. Existing Root connections cannot be reassigned.',
   'Other conversations may work in the same project at the same time, often in other Git worktrees; each owns its own Root. Work only on Goals under your own Root and change only your own working folder. Read other Roots only when the user asks.'
  ],
  constraints:[
   'Setup preserves native permissions, other Hooks and disablement; it never enables Auto mode.',
   'Reception after a response needs the original conversation open with the reply waiter running as a background task. A closed Claude process receives nothing until it is resumed.',
   'Pause from the Web refuses the next tool call and holds new feedback and continuation until Resume. Model settings, usage and cancellation remain native controls.'
  ]
 }
};
