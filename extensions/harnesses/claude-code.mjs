export default {
 id:'claude-code',
 // Reception after a response uses the CLI's reply waiter; setup has no extra option.
 async setupOptions(){return [];},
 guidance:{
  operations:{
   inspect:{command:'connection show',confirmation:'Run through the main Bash tool. Verify the SessionStart identity handoff; existing Root session AND context must match.'},
   createRoot:{command:'connection create-goal --help',confirmation:'A request marker is pending. Only main PostToolUse confirmation establishes the saved Root.'},
   receipt:{command:'connection activity --event <ID> --state <STATE>',states:['working','completed','failed'],confirmation:'Use separate main Bash calls and preserve stdout. Wait for main-hook confirmation; inspect connection request --id <ID> for uncertain results before any retry.'},
   selectWork:null,
   inbox:{command:'connection inbox',confirmation:'Recover pending input or establish a verified prompt through the main hook before expecting ordinary tool hooks to receive input.'},
   reply:{command:'connection reply --event <ID> --text <TEXT>',confirmation:'Posts the Web answer and records the completed receipt in one main-hook confirmation; a retry of the same request does not post twice.'},
   wait:{command:'connection wait',confirmation:'Start it as a Claude background task (Bash run_in_background) whenever a connection result asks for it. It exits when Web feedback is saved, which wakes an idle conversation; then read connection inbox and start it again.'}
  },
  activation:{
   beforeCreate:'Run connection show through the main Bash tool and verify the SessionStart identity before createRoot. Missing identity cannot be replaced with an ordinary goal create, fabricated environment variables or a Codex route.',
   whenUserActionNeeded:'If native Hook review is pending, explain it first. If SessionStart is missing after review, guide the user to resume this same conversation. Open the workspace Web before asking them to act; do not claim a Goal or return path exists yet.',
   userMessage:'The Web page is ready. To receive its replies here, Claude needs to load the connection settings. {observedReviewAction} Then exit and resume this same conversation with claude --resume. I will check the connection and prepare your Goal.',
   confirmation:'After resume, verify connection show and the main PostToolUse confirmation of Root creation. Reuse a Root already owned by this session AND context. Do not clear, fork, launch another receiver or change permissions.'
  },
  nextActions:[
   'For first use, follow onboarding in order, including opening Web; activation below owns the native prerequisites.',
   'Use the actual native project/settings directory. Local settings may be at the main Git repository root. Do not substitute the skill installation directory.',
   'Review native Hooks when required. If SessionStart is missing, explain exiting and resuming THIS SAME conversation. Do not clear, fork, fabricate identity variables or launch a second writer.',
   'Run connection show from main Bash to verify the handoff before creating a Root. Run each connection action separately; a shell receipt alone is not confirmation.',
   'There is no deferred Queue state or goal work route. Keep independent input in the current work plan. Saved Web feedback wakes an idle conversation only while the reply waiter runs; follow the connection results that ask to start it.',
   'Children, Briefs, Comments, Letters and ordinary reads use the shared goal commands. Existing Root connections cannot be reassigned.'
  ],
  constraints:[
   'Setup preserves native permissions, other Hooks and disablement; it never enables Auto mode.',
   'Reception after a response needs the original conversation open with the reply waiter running as a background task. A closed Claude process receives nothing until it is resumed.',
   'Pause holds future continuation, not native execution. Model settings, usage, live execution status and cancellation remain native controls.'
  ]
 }
};
