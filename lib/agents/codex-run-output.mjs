// A Codex run's public output, read on demand from the chat's turns.
import {withCodex} from '../codex-client.mjs';
import {workReader} from '../work-output.mjs';
export const readRunOutput=({threadId,id,at,turnId,matchText})=>withCodex(client=>workReader(client)({
 threadId,messageId:id,turnId,matchText,history:[{status:'saved',at}],
}));
