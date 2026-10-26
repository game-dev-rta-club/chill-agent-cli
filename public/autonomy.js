// Autonomy: how far the agent on a Root goes on its own, stored as 1 to 3 and
// always shown by name. One value per Root's agent, kept in the Root's
// continuation journal (lib/root-autonomy.mjs); every Goal of the tree shows it.
export const autonomyLevels=Object.freeze([
  {level:1,name:'Normal',description:'Does what each comment asks, then waits for you.'},
  {level:2,name:'Auto Continue',description:'Keeps working on what you\'ve agreed, across the whole Root Goal. Questions come as Letters. No tool prompts.'},
  {level:3,name:'Ultra Continue',description:'Plans its own way to the Root Goal\'s success criteria and moves every Goal under it forward. Letters only for your decisions. No tool prompts.'},
]);
export const validAutonomy=level=>Number.isInteger(level)&&level>=1&&level<=autonomyLevels.length;
// A record without a level reads as Normal.
export const autonomyOf=record=>validAutonomy(record?.autonomy)?record.autonomy:1;
