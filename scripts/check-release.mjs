import {readFile} from 'node:fs/promises';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const pkg=await read('package.json');
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version))throw Error('Stable release requires an explicit MAJOR.MINOR.PATCH version.');
for(const file of ['package-lock.json','npm-shrinkwrap.json']){
 let lock;try{lock=await read(file);}catch(e){if(file==='npm-shrinkwrap.json'&&e.code==='ENOENT')continue;throw e;}
 if(lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version||lock.name!==pkg.name)throw Error(`Version/name mismatch in ${file}`);
}
const log=await readFile('CHANGELOG.md','utf8');
if(!log.split('\n').some(line=>line===`## ${pkg.version}`||line.startsWith(`## ${pkg.version} — `)))throw Error('Missing version section in CHANGELOG.md');
const tag=process.argv[2];
if(tag&&tag!==`v${pkg.version}`)throw Error('Release tag must match package version.');
console.log(`Release metadata consistent: ${pkg.name}@${pkg.version}`);
