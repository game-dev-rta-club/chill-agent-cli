#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
const [command='help',...args]=process.argv.slice(2);
const entries={goal:'chill-agent.mjs',server:'chill-server.mjs',setup:'chill-setup.mjs',settings:'chill-settings.mjs',agent:'chill-conversation.mjs',session:'chill-session.mjs',monitor:'chill-monitor.mjs',help:'chill-help.mjs','--help':'chill-help.mjs'};
if(!entries[command])throw Error('Unknown command');
const entry=new URL(entries[command],import.meta.url);process.argv=[process.execPath,fileURLToPath(entry),...args];await import(entry);
