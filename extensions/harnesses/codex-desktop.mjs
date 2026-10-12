export default {
 id:'codex-desktop',
 async setupOptions(){return [];},
 guidance:{
  operations:{
   inspect:{command:'goal show --id <GOAL> --section context --format text',confirmation:'Read the current Goal and its bound conversation before continuing.'},
   createRoot:{command:'goal create --help',confirmation:'Supply --thread-id with the actual calling Codex conversation UUID. Read the saved Root and verify its threadId matches. Do not create an unbound Root or infer identity from the folder.'},
   receipt:{command:'goal activity --event <ID> --state <STATE>',states:['deferred','working','completed','failed'],confirmation:'Check queueError. Deferred must preserve a verified native Queue entry; working removes only the matching entry.'},
   selectWork:{command:'goal work --id <GOAL>',confirmation:'A receipt does not select work or complete the Goal.'}
  },
  activation:{
   beforeCreate:'Identify the actual calling Codex conversation. Hook trust and Goal ownership are separate: do not wait for Hook approval to create/read a Root bound to this verified identity. Saved feedback also has native Queue delivery; an unverified Hook alone does not prove all Web replies are blocked.',
   whenUserActionNeeded:'Only ask for Hook review when native state or a native warning establishes that review is needed. A settings file or connectionVerified:false does not establish that. Never approve trust on the user\'s behalf or bypass it.',
   userMessage:'To receive Web replies while I am working, Codex needs you to review the chill-agent connection (Hook). {observedReviewAction} After that, continue on {goalUrl}.',
   reviewAction:'Use the approval/review control actually offered by the installed Desktop. Identify the project and the chill-agent: Check Web feedback Hook. /hooks is documented for the Codex CLI, not a guaranteed Desktop command. Do not send the user to an unverified menu or ask them to approve every Hook.',
   confirmation:'Do not call installation proof of native trust. Verify the saved Goal owner; distinguish that from an observed Hook receipt or an actual Web round trip. If trust cannot be inspected, state that it is unverified and continue work that does not depend on it.'
  },
  nextActions:[
   'For first use, follow onboarding in order, including opening Web. Use activation only for an actual native connection step.',
   'Use the supplied stable prefix with these command suffixes. Use installed --help for arguments.',
   'For independent later input, defer only if its Queue entry is verified. If deferment fails, inspect current state; do not promise redelivery or blindly enqueue again.'
  ],
  constraints:['Preserve native trust, manual pauses, other queues and the existing conversation. Never assign another Root merely because its project matches.']
 }
};
