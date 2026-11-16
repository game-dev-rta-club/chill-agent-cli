// Autonomy: how far the agent on a Root goes on its own, stored as 1 to 3 and
// always shown by name. One value per Root's agent, kept in the Root's
// continuation journal (lib/root-autonomy.mjs); every Goal of the tree shows it.
export const autonomyLevels=Object.freeze([
  {level:1,name:'Normal',description:'Does what each comment asks, then waits for you.'},
  {level:2,name:'Auto Continue',description:'Carries out what you\'ve agreed anywhere in the Root Goal and keeps its Goals up to date. Questions come as Letters. No tool prompts.'},
  {level:3,name:'Never Stop',description:'Plans its own way to the Root Goal\'s success criteria, reads whatever helps on the web and this machine, except secrets, and keeps going. In Claude Code it always schedules its next check. Letters only for your decisions. No tool prompts.'},
]);
export const validAutonomy=level=>Number.isInteger(level)&&level>=1&&level<=autonomyLevels.length;
// A record without a level reads as Normal.
export const autonomyOf=record=>validAutonomy(record?.autonomy)?record.autonomy:1;
