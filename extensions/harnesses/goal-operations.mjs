// The Goal operations every agent uses, with the same commands; each app adds
// only how it connects (join, wait, wake) in its own guidance.
export const goalOperations={
 inspect:{command:'agent show',confirmation:'Shows which conversation this is and the Roots it owns.'},
 createRoot:{command:'goal create --help',confirmation:'Without --parent, creates a Root owned by this conversation at once and prints its ID. Split Goals use --parent.'},
 selectWork:{command:'goal work --id <GOAL>',confirmation:'Marks the Goal this response works on for the Web until the response ends. A reply does not select work or complete the Goal.'},
 adopt:{command:'goal adopt --id <ID>',confirmation:'Only when the user asks this conversation to take over a Root, from another conversation of any app or one with no owner. The Root keeps its Autonomy; comments not handed yet come here.'},
 release:{command:'goal release --id <ID>',confirmation:'Only when the user asks: the Root then has no owner until a conversation adopts it.'},
 inbox:{command:'goal inbox',confirmation:'Hands any feedback that waits and lists the handed comments whose Goals still wait for a reply. Hooks hand new feedback on their own; read it when you need to recover input.'},
 reply:{command:'goal reply --id <GOAL> --text <TEXT>',confirmation:'Posts the answer on the Goal at once; add --ask \'<what to decide>\' when the user must decide or approve, and it becomes a Letter. A Goal waits for a reply while the user commented after the agent; one reply answers all of it.'},
};
