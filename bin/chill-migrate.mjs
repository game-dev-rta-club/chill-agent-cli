#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {parseArgs} from 'node:util';
import {createMigrationBundle,verifyMigrationBundle,restoreMigrationSource,verifyRestoredSource,prepareMigrationWorkspace,verifyPreparedWorkspace} from '../lib/sqlite-migration.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{source:{type:'string'},destination:{type:'string'},bundle:{type:'string'},help:{type:'boolean'}}});
if(values.help||!positionals.length){console.log('Offline SQLite migration (Node >=24.15)\n  create --source <legacy-workspace> --destination <new-bundle>\n  verify --bundle <bundle>\n  restore --bundle <bundle> --destination <new-offline-workspace>\n  verify-restored --bundle <bundle> --destination <offline-workspace>\n  prepare --bundle <bundle> --destination <new-offline-data-directory>\n  verify-prepared --bundle <bundle> --destination <offline-data-directory>\nStop source writers for a consistent snapshot. Originals are never modified. The bundle is not a runtime data directory; delivery state is archived, never activated.');}
else if(positionals.length!==1)throw Error('Choose create, verify, restore, verify-restored, prepare or verify-prepared.');
else if(positionals[0]==='create'&&values.source&&values.destination)console.log(JSON.stringify(await createMigrationBundle(values.source,values.destination),null,2));
else if(positionals[0]==='verify'&&values.bundle)console.log(JSON.stringify(await verifyMigrationBundle(values.bundle),null,2));
else if(positionals[0]==='restore'&&values.bundle&&values.destination)console.log(JSON.stringify(await restoreMigrationSource(values.bundle,values.destination),null,2));
else if(positionals[0]==='verify-restored'&&values.bundle&&values.destination)console.log(JSON.stringify(await verifyRestoredSource(values.bundle,values.destination),null,2));
else if(positionals[0]==='prepare'&&values.bundle&&values.destination)console.log(JSON.stringify(await prepareMigrationWorkspace(values.bundle,values.destination),null,2));
else if(positionals[0]==='verify-prepared'&&values.bundle&&values.destination)console.log(JSON.stringify(await verifyPreparedWorkspace(values.bundle,values.destination),null,2));
else throw Error('Use --help for migration arguments.');
