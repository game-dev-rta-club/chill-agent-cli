import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listSkills,mentionedSkills,skillFrontmatter,skillLines} from '../lib/skill-catalog.mjs';

test('frontmatter reads name and plain or folded descriptions',()=>{
 assert.deepEqual(skillFrontmatter('---\nname: a\ndescription: "Short one"\n---\nBody'),{name:'a',description:'Short one'});
 assert.deepEqual(skillFrontmatter('---\ndescription: >-\n  Folded\n  text\nname: b\n---\n'),{description:'Folded text',name:'b'});
 assert.deepEqual(skillFrontmatter('No frontmatter'),{});
});
test('project skills, user skills and commands are listed; the project wins a name clash',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-skills-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const project=join(dir,'project'),home=join(dir,'home');
 const skill=async(base,parts,name,description)=>{await mkdir(join(base,...parts,name),{recursive:true});await writeFile(join(base,...parts,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${description}\n---\n`);};
 await skill(project,['.agents','skills'],'deploy','Project deploy');
 await skill(home,['.claude','skills'],'deploy','User deploy');
 await skill(home,['.codex','skills','.system'],'grill','Ask questions');
 await mkdir(join(project,'.claude','commands'),{recursive:true});await writeFile(join(project,'.claude','commands','review.md'),'---\ndescription: Review a change\n---\n');
 await mkdir(join(project,'.claude','skills','empty'),{recursive:true});
 assert.deepEqual(await listSkills({project,home}),[
  {name:'deploy',description:'Project deploy',scope:'project'},
  {name:'grill',description:'Ask questions',scope:'user'},
  {name:'review',description:'Review a change',scope:'project'},
 ]);
});
test('skills named in feedback come with the file to read, user skills included',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-skills-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const project=join(dir,'project'),home=join(dir,'home');
 await mkdir(join(home,'.claude','skills','grilling'),{recursive:true});await writeFile(join(home,'.claude','skills','grilling','SKILL.md'),'---\nname: grilling\ndescription: Ask\n---\n');
 await mkdir(join(project,'.claude','commands'),{recursive:true});await writeFile(join(project,'.claude','commands','review.md'),'---\ndescription: Review\n---\n');
 const found=await mentionedSkills(['どうしよう /grilling ですり合わせたい','see /Users/x and /review, not /unknown'],{project,home});
 assert.deepEqual(found.map(s=>[s.name,s.scope,s.file]),[
  ['grilling','user',join(home,'.claude','skills','grilling','SKILL.md')],
  ['review','project',join(project,'.claude','commands','review.md')],
 ]);
 assert.ok(skillLines(found).includes(`/grilling (user): ${join(home,'.claude','skills','grilling','SKILL.md')}`));
 assert.deepEqual(await mentionedSkills(['no skill here'],{project,home}),[]);
 // Mid-sentence, right after Japanese text or before a full stop, but not inside a path or URL.
 assert.deepEqual((await mentionedSkills(['これを/grillingで詰めたい'],{project,home})).map(s=>s.name),['grilling']);
 assert.deepEqual((await mentionedSkills(['最後に /review.'],{project,home})).map(s=>s.name),['review']);
 assert.deepEqual(await mentionedSkills(['see docs/grilling and https://x.test/review'],{project,home}),[]);
 assert.equal(skillLines([]),'');
});
