import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageForCommit,useIn} from '../scripts/use-in.mjs';
import {recordVersionSource} from '../lib/version-source.mjs';
import {projectDirectory} from '../lib/project-workspace.mjs';

test('GitHub remotes become npm github specs; other remotes keep their git URL',()=>{
 const sha='a'.repeat(40);
 for(const url of ['https://github.com/org/cli.git','https://github.com/org/cli','git@github.com:org/cli.git'])assert.equal(packageForCommit(url,sha),`github:org/cli#${sha}`);
 assert.equal(packageForCommit('https://gitlab.example.com/org/cli.git',sha),`git+https://gitlab.example.com/org/cli.git#${sha}`);
});

test('use-in writes the pushed commit to the recorded version file and refuses unpushed commits',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-use-in-')));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 const remote=join(dir,'remote.git'),repo=join(dir,'repo'),project=join(dir,'project'),base=join(dir,'base');
 git(dir,'init','-q','--bare',remote);await mkdir(repo);git(repo,'init','-q');
 git(repo,'-c','user.name=t','-c','user.email=t@example.invalid','commit','-q','--allow-empty','-m','one');
 git(repo,'remote','add','origin',remote);git(repo,'push','-q','origin','HEAD:refs/heads/main');
 await mkdir(join(project,'skill'),{recursive:true});const versionFile=join(project,'skill/cli.json');
 await writeFile(versionFile,JSON.stringify({package:'old'}));
 await assert.rejects(useIn({project,repo,base}),/has not recorded a version file/);
 await recordVersionSource(await projectDirectory(project,base),{versionFile});
 const sha=git(repo,'rev-parse','HEAD');
 const result=await useIn({project,repo,base});
 assert.equal(result.from,'old');assert.equal(result.to,`git+${remote}#${sha}`);
 assert.deepEqual(JSON.parse(await readFile(versionFile,'utf8')),{package:`git+${remote}#${sha}`});
 git(repo,'-c','user.name=t','-c','user.email=t@example.invalid','commit','-q','--allow-empty','-m','two');
 await assert.rejects(useIn({project,repo,base}),/not on the remote yet/);
 assert.deepEqual(JSON.parse(await readFile(versionFile,'utf8')),{package:`git+${remote}#${sha}`},'a refused run leaves the file unchanged');
});
