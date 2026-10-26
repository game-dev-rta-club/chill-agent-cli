// Autonomy: how far the agent goes on its own for one Goal, 1 to 4. Each Goal
// keeps its own value; a new Goal copies its parent's when it is created.
export const autonomyLevels=Object.freeze([
  {level:1,name:'Normal',tip:'Work as usual. chill adds nothing.'},
  {level:2,name:'Thorough',tip:'Think in my place. Accuracy over speed: research widely, then give your best answer.'},
  {level:3,name:'Continue',tip:'After each turn, keep working on what we agreed for this Goal. Tool requests are approved.'},
  {level:4,name:'Drive',tip:'Drive the whole project under this Root. Move forward everything that doesn\'t need my decision; ask the rest as Letters.'},
]);
export const validAutonomy=level=>Number.isInteger(level)&&level>=1&&level<=autonomyLevels.length;
// A Goal saved before Autonomy existed reads as Normal.
export const autonomyOf=goal=>validAutonomy(goal?.autonomy)?goal.autonomy:1;
