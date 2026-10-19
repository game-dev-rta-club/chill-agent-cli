// A Codex run's public output, read on demand from the chat's turns.
import {withCodex} from '../codex-client.mjs';
import {workReader} from './codex-work-output.mjs';
export const readRunOutput=({threadId,at,turnId,matchText})=>withCodex(client=>workReader(client)({
 threadId,turnId,matchText,history:[{status:'saved',at}],
}));
