#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
const [command='help',...args]=process.argv.slice(2);
const entries={goal:'chill-agent.mjs',server:'chill-server.mjs',setup:'chill-setup.mjs',settings:'chill-settings.mjs',hook:'chill-hook.mjs',connection:'chill-connection.mjs',help:'chill-help.mjs','--help':'chill-help.mjs'};
if(!entries[command])throw Error('Unknown command');
const entry=new URL(entries[command],import.meta.url);process.argv=[process.execPath,entry.pathname,...args];await import(entry);
