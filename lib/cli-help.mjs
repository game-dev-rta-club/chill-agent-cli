import {readFileSync} from 'node:fs';
// Command contracts live here: both argument parsing and help use these definitions.
// Pure data/rendering: help never opens the store, connects to Codex, or starts a server.
const option = (value, description, extra = {}) => ({ value, description, ...extra });
const id = option('N', 'Existing numeric Goal ID.', { required: true });
const version = option('N', 'Deliverable history version.', { defaultText: 'latest' });
const briefFormat = option('format','Deliverable source format; omit to use the current format (initially html).',{choices:['markdown','html']});
const event = option('N', 'User feedback event ID.', { required: true });
const harness=option('harness','Connection to prepare or inspect.',{choices:['codex-desktop','claude-code'],defaultText:'codex-desktop'});
const serverOptions = {
  '--idle-timeout': option('duration', 'Positive duration with ms, s, m, h, or d. CLI overrides the environment.', { defaultText: 'CHILL_AGENT_IDLE_TIMEOUT or 3d' }),
  '--configured': option(null, 'Use saved remote settings; off means local only.'),
  '--local': option(null, 'Start locally, ignoring saved remote settings.'),
  '--tunnel': option(null, 'Use a temporary public Quick Tunnel without login protection.'),
};
const serverDetail = `The default exposure is loopback only. Choose at most one exposure flag.
Project workspaces use their saved automatic port; legacy stores default to 4173.
An explicit PORT overrides it. Use the same project command for start/status/stop.
Idle means no real use: Web interaction and CLI writes renew the lease; background
polling and CLI reads do not. Shutdown waits for active work. Saved data remains.
The server owns its tunnel and stops it on shutdown. cloudflared must already be
installed for remote access; CHILL_AGENT_CLOUDFLARED_PATH can select its executable.
Remote setting changes take effect on the next start, not on a running server.`;
const fileOrOff = {
  '--file': option('file.json', 'Read and validate a settings JSON file before saving.'),
  '--off': option(null, 'Disable this capability; leave the other settings unchanged.'),
};
const exactlyFileOrOff = { exactlyOne: [['--file', '--off']] };
const feedbackFormat = `JSON input:
{"text":"Could we simplify this?","requestId":"unique-retry-id"}
Conversation belongs to the Goal and works before any Deliverable update.
Supply text, images or annotations.
requestId is 8-80 letters/digits/hyphens. Identical retries are idempotent; changed
content with an already saved requestId fails. Do not resubmit a saved message.

attachmentIds: distinct uploaded attachment IDs (images or other files).
annotations: entries, each with kind, text, and
optional attachmentIds. Each annotation needs text or images.
Letter answer: {"kind":"letter","text":"Slack would be good",
"source":{"kind":"comment","eventId":42}}. The target must be an Agent Letter
in this Goal; only user Letter annotations answer it. Other annotations, comments,
reading and Deliverable updates do not answer Letters. A reply is not approval or unblocking.
Text: {"kind":"text","text":"Explain this","anchor":{"start":0,"end":5,
"quote":"Hello"},"source":{"kind":"deliverable","version":1}}.
Agent comment: source:{"kind":"comment","eventId":42}.
Letter title: source:{"kind":"comment","eventId":42,"field":"title"}.
Offsets are UTF-16 into rendered Markdown text (including collapsed sections),
excluding diagram contents; Letter titles use their plain text.
For field:title they refer to the Letter title, not its message text.
Image: {"kind":"image","text":"Here","imageId":"uploaded-id",
"rect":{"x":0.1,"y":0.2,"width":0.3,"height":0.2}}; normalized within the image.

Outputs saved feedback first, then delivery. An unassigned root saves locally.
An assigned root delivers user feedback to its chat. Agents use comment or letter.`;
const agentMessageOptions={
  '--id':id,'--text':option('text','Plain text.'),
  '--text-file':option('file.txt','UTF-8 plain text.'),
};
export const commands = {
  '': {summary:'Chill Agent — Goals, editable Deliverable, and Conversation.',children:['goal','server','settings','hook','connection'],detail:`Use the command returned by setup prepare as "chill".
From a checkout: node bin/chill-agent.mjs <command>.
CHILL_AGENT_DATA_DIR selects the shared store. Default on macOS:
~/Library/Application Support/chill-agent; on Windows: %USERPROFILE%\\.chill-agent.
New data lives in workspace/.
Only the current workspace format is loaded. Convert old data outside the runtime.
Help has no side effects. Node.js 20+; optional Codex delivery on macOS.`},
  connection:{summary:'Connect a Claude conversation to its Goals.',children:['show','join','create-goal','adopt','inbox','reply','wait','wake','claude-hook','claude-watch'],detail:'Commands for Claude conversations. Each command acts at once for the conversation Claude Code names in its shell. setup prepare --harness claude-code installs project hooks, including a watcher hook that wakes an idle conversation for Web replies; live controls are unavailable. Default Codex setup is unchanged.'},
  'connection show':{summary:'Check the Claude connection and recorded watcher state.',detail:'Requires CHILL_AGENT_DATA_DIR and a Claude shell (CLAUDE_CODE_SESSION_ID) whose conversation was recorded at SessionStart or with connection join. Returns identity, the Root Goals this conversation owns (other conversations in the same project own their own), and the recorded hook and watcher state. This is not authentication or native live state.'},
  'connection join':{summary:'Connect a Claude conversation that started before setup, without resuming it.',detail:'Run once when connection show reports no connection. It records the session that Claude names in this shell. An existing connection is kept. Then use connection show and create or reuse a Goal.'},
  'connection create-goal':{summary:'Create a new Root in this Claude conversation.',options:{'--title':option('text','Goal name.',{required:true}),'--scope':option('text','Agreed scope.'),'--criteria':option('text','Success criteria.')},detail:'Creates the Root at once and prints its ID. Existing Goals are never reassigned.'},
  'connection adopt':{summary:'Take over a Goal from an earlier Claude conversation that this one continues.',options:{'--goal':option('N','Goal ID; its root Goal moves.',{required:true})},detail:'Use when the user asks this conversation to continue a Goal owned by an earlier conversation, for example after Claude continued the chat in a new session. The root Goal and its Split Goals move to this conversation, and feedback saved for the earlier one is delivered here. Codex Goals use goal assign.'},
  'connection inbox':{summary:'Read the feedback that awaits a reply in this Claude conversation.',detail:'Across all owned Roots. Hands any feedback that waits, then lists every handed comment whose Goal still awaits a reply. Hooks hand new feedback on their own; use this to recover input. Nothing is handed while the conversation is paused from the Web.'},
  'connection reply':{summary:'Reply on a Goal on the Web; the Goal no longer awaits a reply.',options:{'--goal':option('N','Goal to reply on.',{required:true}),'--text':option('text','Plain text.'),'--text-file':option('file.txt','UTF-8 plain text.')},exactlyOne:[['--text','--text-file']],detail:'Posts the reply in the Goal Conversation of a Root this conversation owns. A Goal awaits a reply while the user wrote last in it; which comment a reply answers is not tracked. Does not mark the Goal Done.'},
  'connection wake':{summary:'Schedule a check of something outside chill (CI, a build); the watcher wakes this conversation then.',options:{'--in':option('minutes','Whole minutes, at least 1.'),'--reason':option('text','What the check is for, shown when it is due.'),'--cancel':option(null,'Cancel the scheduled check.')},detail:'Use it before ending a response that waits for something chill cannot see, such as CI finishing. Finished CI wakes nobody by itself; the watcher wakes this conversation at the scheduled time. One check is kept per conversation; scheduling again replaces it.',examples:["chill connection wake --in 10 --reason 'CI of PR #91'","chill connection wake --cancel"]},
  'connection claude-watch':{summary:'Watch a Claude conversation for Web replies and due checks (installed asyncRewake hook).',detail:'Installed by setup prepare --harness claude-code on SessionStart and Stop. Reads the hook input from stdin and runs in the background while the conversation owns Goals. When Web feedback is saved it claims it, as a tool hook does, and exits 2 so Claude Code wakes the model with the feedback; a due connection wake check wakes it the same way. One watcher per conversation; it follows compact and clear, and takes over from an older connection wait waiter. In Claude Desktop a connection wait task only keeps the conversation from being paused; this hook still claims the feedback and wakes it. The agent does not start, read or restart it.'},
  'connection wait':{summary:'Background task: in Claude Desktop it keeps the conversation from being paused; without the watcher hook it is the reply waiter.',detail:'Start it as a Claude background task (Bash run_in_background) from the conversation that owns the Goals, then continue. In Claude Desktop with the watcher hook it only holds the conversation, which Desktop never pauses while a task runs: it neither claims feedback nor ends for it, and the hook wakes the model with the feedback. One per session; a second one exits at once. Without the hook it is the waiter: it exits when saved feedback is available or a scheduled check is due, which wakes an idle conversation. Then run connection inbox (it shows the feedback and any due check) and start the waiter again in one response; the output need not be read. One waiter per conversation context. It only detects; the inbox or a hook offers the feedback.'},
  'connection claude-hook':{summary:'Handle native Claude startup, prompt, main tool, Stop and exit hooks from stdin.',detail:'Installed by setup prepare --harness claude-code. SessionStart records the conversation, and names connection wait only in Claude Desktop (to keep the conversation from being paused) or when the project hooks lack the watcher (connection claude-watch). Main PostToolUse offers saved feedback as additionalContext. Stop holds the response once when feedback it took has had no reply or Comment on its Goal since it last stopped and no background work keeps running, and lets a trusted composed connection extension request a continuation; the standalone CLI supplies no Auto mode policy. UserPromptSubmit and SessionEnd record the last hook. Subagent hooks never receive feedback, since it would end with the subagent. No transcript reads, automatic setup or permission changes.'},
  goal:{summary:'Share Goals, keep a Deliverable, and exchange Comments / Letters.',children:['create','update','assign','work','deliverable','comment','letter','close-letter','delete-comment','show','tree','review','check','feedback','image','send-now'],detail:'Goal names are stable. The Deliverable holds only the Goal’s final output, edited in a Markdown or HTML file;\nplans and progress belong in Conversation.\nConversation belongs to the Goal; Letters are titled Agent comments needing a reply.'},
  'goal create':{summary:'Create a Goal, optionally under a parent.',options:{
    '--title':option('text','Goal name.',{required:true}),
    '--parent':option('N','Parent Goal ID.',{defaultText:'root Goal'}),
    '--scope':option('text','Agreed scope.',{defaultText:'empty'}),
    '--criteria':option('text','Success criteria for checking outcomes.',{defaultText:'empty'}),
    '--thread-id':option('uuid','Optional root chat for Web feedback. Omit for local-only use.'),
  },detail:'Returns JSON with the new ID. The editable Deliverable starts empty. Parent must exist.\nA child inherits the root chat; only a root can be assigned a chat.',examples:["chill goal create --title 'Improve writing' --scope 'Editor and annotations'","chill goal create --title 'Improve annotation input' --parent 1"]},
  'goal update':{summary:'Update Goal metadata, parent, or manually recorded work state.',options:{'--id':id,'--input-file':option('file.json','JSON patch.',{required:true})},detail:`Allowed fields: title, scope, criteria, parentId (string ID or null),
state (idle / waiting / done), started (boolean), waitReason, threadId (UUID or null), archived (boolean; root Goals only).
Set archived:true to hide a root and its descendants from lists and monitoring;
set archived:false to restore it. IDs, Deliverables and Conversation are retained.
Waiting requires a reason. Reparenting cannot create a cycle. A Split Goal of a Claude conversation's Root may become a Root (parentId null) of that same conversation; connection adopt then hands it to another. Goal metadata changes
do not rewrite Deliverable. Working comes from work selection plus live Codex evidence.
Mark done only after the agreed criteria are met; record the evidence with comment.
Done is rejected if any descendant is not done. Completing children never completes
their parent automatically. The response reminds you to review ancestor criteria.
Adding a child, moving one under a new parent, or reopening a Done child reopens
Done ancestors to idle. Set a Done Goal to idle explicitly before resuming work.
Progress: count leaf Goals equally. Done contributes 100%; unfinished contributes 0%.
The aggregate is completed leaves / all leaves, rounding only the final percent.
Unfinished Goals are capped at 99%. Done never overrides the measured percentage.
A Goal without children contributes its own completion. Deliverable updates, replies, started
and Working do not affect progress; a reply does not complete or unblock a Goal.
Display priority: self/any child working → Running; confirmed self pause → Paused;
self waiting or all unfinished
children waiting → Waiting; explicitly done → Done; otherwise no badge (Open).
Stored states remain idle / waiting / done; Running and Paused are observed activity.
Letter counts and work state are independent.`},
  'goal assign':{summary:'Connect a root Goal to a verified Codex chat, or disconnect it.',options:{'--id':id,'--thread-id':option('uuid','Saved Codex chat ID.'),'--off':option(null,'Save future feedback locally only.')},exactlyOne:[['--thread-id','--off']],detail:'Checks chat existence and queue support. Children inherit this owner.\nDoes not replay saved comments. Use retry explicitly to deliver a locally saved\nevent after assignment. Possibly sent events keep their original recipient.'},
  'goal work':{summary:'Select the Goal being worked on in this turn, or stop tracking it.',options:{'--id':id,'--stop':option(null,'Stop tracking this Goal.')},detail:'Run it from the Root\'s own conversation during an unfinished turn (response).\nSelects one Goal per chat; switching replaces the previous selection. The Goal\nmust be idle (resolve Waiting or reopen Done explicitly); sets started:true.\nWorking uses current turn evidence (and, for some agents, recent tool heartbeats). Turn end\nhides Working but never marks a Goal done; stale/unavailable observations hide Working.\nA new turn needs a new work selection. Publishing or replying does not switch it.\nUse update for Waiting (with reason), idle to resume, or done after criteria are met.\nCheck outcomes against criteria and report the result with comment.',examples:["chill goal work --id 2","chill goal work --id 2 --stop"]},
  'goal deliverable':{summary:'Edit the Goal’s final output in an HTML or Markdown source and publish it.',children:['path','update'],detail:'The Deliverable shows this Goal’s final output. How to write it is in the agent\nguide recorded at setup; this help covers only the commands.'},
  'goal deliverable path':{summary:'Locate an editable deliverable.md or deliverable.html.',options:{'--id':id,'--format':briefFormat},detail:'Returns the stable absolute path, format and latest saved version.\nSelecting a path does not publish or change the current format.\nEdit that file directly, then run deliverable update to publish the change.'},
  'goal deliverable update':{summary:'Publish the edited Deliverable; snapshot when content or format changes.',options:{'--id':id,'--format':briefFormat},detail:'Reads deliverable.md or deliverable.html (up to 1 million characters). HTML is a standalone document with inline CSS and SVG; scripts, forms and remote assets do not run.\nHTML renders in an isolated frame with text annotations. Switching format preserves history and both editable files.\nUpdates Web and saves an immutable history snapshot; identical content is not published and the command fails.\nEdits do not affect Web until this command succeeds. Empty content clears Deliverable.\nMarkdown supports headings, lists, tables, code, links and Mermaid code fences.\nHeadings ## through ###### form initially collapsed, nested sections. Images use\n![Description](/api/images/<uploaded-id>). Active HTML is filtered before rendering.\nNo new Conversation, Letter, Goal state change or notification is created.',examples:['chill goal deliverable path --id 1 --format html','chill goal deliverable update --id 1 --format html','chill goal deliverable update --id 1 --format markdown']},
  'goal comment':{summary:'Share progress, results, or a normal response in Conversation.',options:agentMessageOptions,exactlyOne:[['--text','--text-file']],detail:'Use letter when you need the user to answer; comment shares information.\nWorks even before a Deliverable exists. Does not answer or close any Letter.\nReturns the saved event ID. Markdown renders in Conversation, including tables\nand Mermaid; ## and deeper headings form collapsed, nested sections. This command does not send external user notifications.'},
  'goal letter':{summary:'Ask for a necessary user reply, choice or permission.',options:{...agentMessageOptions,'--no-reply':option(null,'Deprecated compatibility option; keep one Letter format.'),'--title':option('text','Short title for the Letters list.',{required:true})},exactlyOne:[['--text','--text-file']],detail:'Letter is a titled Agent question requiring a user reply, choice or permission.\nUse goal comment for results, completion reports and routine progress.\nLetter has no consultation/notice subtype; sending one does not require work to wait.\nLegacy --no-reply records remain excluded from pending counts for compatibility.\nUser answers explicitly identify this Letter; ordinary comments do not close it.\nSending a Letter does not update Deliverable or pause a Goal. Continue other agreed\nwork while waiting. For a follow-up question, send another Letter. No reopen step.\nReturns the Letter event ID and link. No external notification is sent here.',examples:["chill goal letter --id 1 --title 'Notification method' --text 'Where would you like to receive updates?'"]},
  'goal delete-comment':{summary:'Delete an agent Comment or Letter posted by mistake.',options:{'--id':id,'--event':option('N','Agent Comment or Letter event ID in this Goal.',{required:true})},detail:'Use it for a message posted to the wrong Goal or project. The text, title and images are\nremoved from Conversation for every reader; user comments cannot be deleted. Deleting\nan already deleted message changes nothing.',examples:["chill goal delete-comment --id 10 --event 94"]},
  'goal close-letter':{summary:'Record that a Letter was answered by a user Comment, or no longer needs an answer.',options:{'--id':id,'--event':option('N','Agent Letter event ID in this Goal.',{required:true}),'--answer':option('N','The user Comment in this Goal that answered the Letter. Marks it Replied on Web.'),'--reason':option('text','Optional explanation.')},detail:'Users answer Letters with ordinary Comments. When a delivered Comment answers a\nLetter, record it with --answer before other work, so the Web stops counting it\nas pending. Without --answer the Letter is marked Received: use that only when no\nanswer is needed any more. Leave it open while the question is still unanswered.\nPreserves the Letter text, position and annotations. Already closed Letters are\nunchanged. No Conversation post, Goal completion, approval or unblocking is\ncreated. For a new question, send a new Letter.',examples:["chill goal close-letter --id 5 --event 42 --answer 44","chill goal close-letter --id 5 --event 42 --reason 'The choice is settled in the discussion.'"]},
  'goal show':{summary:'Read one Goal, its Deliverable, Letters and recent Conversation.',options:{'--id':id,'--version':version,'--since':option('cursor','Conversation changes after this event ID; returns all newer messages unless --limit is given.'),'--before':option('cursor','Conversation changes before this event ID.'),'--limit':option('N','Latest matching messages, 1–100.',{defaultText:'5 in text; all in JSON or with --since'}),'--full':option(null,'Full Deliverable and conversation; include branch summaries.'),'--section':option('section','Read just one part (text only).',{choices:['all','context','deliverable','conversation','letters'],defaultText:'all'}),'--deliverable-offset':option('N','Continue the selected Deliverable at this character offset (text only).'),'--format':option('format','Readable text or structured JSON.',{choices:['text','json'],defaultText:'json'})},atMostOne:[['--full','--limit']],detail:'Text shows one Goal, root agreement, own unanswered Letters and recent messages.\n--section context keeps the agreement and messages, linking to Deliverable and Letter bodies instead of dumping them.\nDeliverable text is paged at 6000 characters with a version-pinned continuation command.\nOlder conversation pages include their next --before command. --since preserves all newer feedback.\n--version selects Deliverable history only; tree, Letters and Conversation stay current.\nAnswer targets retain the original questions for replies in the selected page.\nJSON remains complete by default, including annotation sources and images.\nUse review for the subtree index. Reading never completes work or consumes queues.',examples:['chill goal show --id 5 --format text','chill goal show --id 5 --since 17 --format text','chill goal show --id 5 --format text --section conversation --before 17 --limit 5','chill goal show --id 5 --format text --full']},
  'goal review':{summary:'Browse a subtree as one line per Goal, with indentation, state and progress.',options:{'--id':id,'--state':option('state','Filter by Web display state; unfinished includes every state except Done.',{choices:['all','unfinished','open','running','paused','waiting','done'],defaultText:'all'}),'--letters':option(null,'Only Goals with their own unanswered Letters.'),'--limit':option('N','Matching Goals per page, 1–200.',{defaultText:'50'}),'--after':option('ID','Continue after this Goal in parent-first order.')},detail:'Includes the selected Goal and all descendants, including Done branches.\nAncestor context rows preserve indentation; they are not counted in this page.\nNo Deliverable bodies or conversation history. Counts and a next-page command make omissions explicit.\nLetters are counted only on their own Goal, never duplicated on ancestors.\nResults include commands for reading a Goal and useful filters. State is live at each read.\nRead-only: does not start work, answer Letters or change queues.',examples:['chill goal review --id 1','chill goal review --id 1 --state unfinished','chill goal review --id 1 --state open','chill goal review --id 1 --letters']},
  'goal tree':{summary:'Read a compact tree, progress, and pending Letters as JSON.',options:{'--id':{...id,required:false,defaultText:'all root Goals'}},detail:'No Deliverable bodies or conversation history. --id narrows to one subtree.\nIncludes scope/criteria and execution evidence. Counts include descendants.\nUse show to read a Goal. No model execution is started.'},
  'goal check':{summary:'Read a global cursor and user-feedback count without bodies.',options:{'--id':{...id,required:false},'--since':option('cursor','Count user events after this ID.',{defaultText:'0'})}},
  'goal feedback':{summary:'Save user Conversation and deliver only if a root chat is assigned.',options:{'--id':id,'--input-file':option('file.json','JSON path, or - for stdin.',{required:true})},detail:feedbackFormat},
  'goal image':{summary:'Save a local image as a Web attachment.',options:{'--file':option('path','PNG, JPEG or WebP.',{required:true})},detail:'Returns JSON with id, mimeType and src. Use src in Deliverable Markdown or id in feedback.'},
  'goal send-now':{summary:'Hand Waiting feedback to the running work now.',options:{'--event':event},detail:'Feedback saved while the agent works waits until that work ends (Waiting).\nSend now hands every waiting comment of its Root to the running work, as the Web button does. Does not create feedback.'},
  server:{summary:'Manage the background Web server and its optional tunnel.',children:['start','restart','status','stop']},
  'server start':{summary:'Start Web independent of this chat (launchd on macOS, Task Scheduler on Windows).',options:serverOptions,atMostOne:[['--tunnel','--configured','--local']],detail:`${serverDetail}

A running server is reused by the caller; start itself reports an error if already
running. Use server restart --configured to adopt a prepared runtime while keeping its public URL. No login
autostart is installed. Unexpected exits restart; idle shutdown does not.
Logout/reboot stops the service; a sleeping Mac cannot serve the phone.
Returns local URL, optional tunnel URL, timeout, and log path.
For foreground development or other OSes: node server.mjs --help`,examples:['chill server start --configured','chill server start --local --idle-timeout 12h']},
  'server restart':{summary:'Update Web while preserving its managed public tunnel.',options:serverOptions,atMostOne:[['--tunnel','--configured','--local']],detail:'Use --configured to resume saved public access. Legacy servers rotate the URL once during migration. Off and server stop still close the tunnel.'},
  'server status':{summary:'Show running/stopped status, live URLs, idle timeout, and log path.',detail:'Read-only. Use the same PORT and CHILL_AGENT_DATA_DIR as the server.'},
  'server stop':{summary:'Stop the background server and its owned tunnel.',detail:'Use the same PORT and CHILL_AGENT_DATA_DIR as start. Saved Goals/settings remain.'},
  settings:{summary:'Read or change notification and remote-access preferences.',children:['show','remote','notifications','notice','notice-result'],detail:'Defaults are off. Settings live in this data directory. A composed notification\nprovider can scope preferences to a Root Goal. A notification provider may deliver a selected event through settings notice.'},
  'settings show':{summary:'Read current settings; --id selects a Root in composed runtimes.',options:{'--id':option('N','Goal in the Root to inspect.')}},
  'settings remote':{summary:'Save remote-access settings for the next server start.',options:fileOrOff,...exactlyFileOrOff,detail:`JSON forms:
  {"mode":"off"}
  {"mode":"quick"}
  {"mode":"named","url":"https://plans.example.com",
   "tunnelId":"00000000-0000-0000-0000-000000000001",
   "credentialsFile":"/absolute/path/to/credentials.json",
   "accessTeam":"your-team","accessAud":["<64-character Access AUD tag>"]}

Named mode requires a fixed HTTPS origin (no path/port/credentials), tunnel UUID,
absolute credentials-file path, Access team name, and 1-10 audience tags.
No other fields are accepted. Store references only; keep credential contents
in Cloudflare's own file. The named connector validates Access JWTs on ingress.
Locally managed named tunnels are supported; dashboard token tunnels are not.

Quick is an unauthenticated public test URL that changes on restart. Every Goal
in the selected data directory is exposed, including the ability to send feedback.
Named mode requires a correctly configured Cloudflare Access application/policy;
an account or tunnel alone does not restrict access. See the setup Skill for
external account setup and phone verification.

Saving or --off does not stop a running tunnel. Stop and restart the server to
apply settings. Invalid input leaves saved settings intact. Notifications remain.`,examples:['chill settings remote --file /tmp/remote.json','chill settings remote --off']},
  'settings notifications':{summary:'Save notification preferences; composed runtimes require --id for a Root.',options:{...fileOrOff,'--id':option('N','Goal in the Root to configure.')},...exactlyFileOrOff,detail:`JSON forms:
  {"enabled":false}
  {"enabled":true,"tool":"verified-send-tool-id","destination":"recipient-id",
   "on":["comment","letter"]}

on contains comment (shared updates), letter (needs user input), or both.
With a composed provider, {"enabled":true} reuses the Root's connection;
{"enabled":true,"profileId":"saved-profile-id"} selects a saved profile from show.
Other fields are rejected. tool/destination are identifiers, not shell
commands or credentials. Validate the actual host tool and agree on the recipient
and occasions with the user before saving. Invalid input leaves settings intact.
The agent reads these preferences in new chats and uses notice before sending.
The server/Hook only remind; they do not send messages or ingest Slack replies.
Disabling notifications retains the connection and does not stop remote page access.
A composed notification provider requires --id for the affected Root.`,examples:['chill settings notifications --id 1 --file /tmp/notifications.json','chill settings notifications --id 1 --off']},
  'settings notice-result':{summary:'Record host-tool acceptance, failure or uncertainty without sending.',options:{'--id':id,'--notice':option('UUID','Prepared notification ID.',{required:true}),'--outcome':option('state','Host tool result, not device delivery.',{required:true,choices:['sent','failed','unconfirmed']})}},
  'settings notice':{summary:'Handle a selected notification through the configured provider.',options:{'--id':id,'--event':option('N','Saved Agent Comment or Letter event ID.',{required:true})},detail:'A notification provider reserves this saved event once. It may deliver directly and return handled/delivery, or return the exact message and a host-tool result command. Direct delivery needs no second send. Repeating preparation never authorizes another send.\nRead immediately before sending. Disabled or unmatched preferences return\n{"enabled":false}. Otherwise returns tool, destination, title and the running\nmobile URL for this saved comment. A null URL is not a usable phone link.\nUse the configured host tool once; report missing tools or uncertain delivery.',examples:['chill settings notice --id 1 --event 42']},
  hook:{summary:'Hand Web feedback after tool calls and at stops (normally invoked by Codex).',options:{'--install':option(null,'Install the project PostToolUse and Stop Hooks in the current directory.')},detail:`Without --install, reads a Codex hook JSON object from stdin. PostToolUse prints additional
context with feedback the user sent now to the running turn, across all Goals.
Stop hands feedback that waited for the turn, which then goes on; otherwise it holds
the turn once when a Goal it was handed feedback on still awaits a reply, asking it to
tell the user where things stand. Paused chats are handed nothing. Not a polling daemon.
--install preserves other hooks in .codex/hooks.json. It stores absolute runtime
paths; keep that machine-specific file outside Git. Codex may require /hooks trust
for a new definition; the installer does not alter trust records. Prefer setup
prepare for a stable runtime. An idle chat is sent waiting feedback as its next message.`},
  setup:{label:'chill-setup',summary:'Prepare a stable CLI/Hook installation from the core plugin.',children:['status','prepare','remove'],detail:'Requires Node.js 20+. Codex Desktop on macOS is the default. Explicit --harness claude-code prepares experimental POSIX project hooks without consulting Codex. CHILL_AGENT_DATA_DIR selects the store. Default invocation is status. Help has no side effects.'},
  'setup status':{label:'chill-setup status',summary:'Read installation and configuration without proving native activation.',options:{'--harness':harness,'--project':option('directory','Project to inspect.'),'--isolated':option(null,'Inspect its isolated project store.') }},
  'setup remove':{label:'chill-setup remove',summary:'Remove only recorded Claude project hooks; preserve Goals and other settings.',options:{'--harness':option('harness','Explicit native connection.',{required:true,choices:['claude-code']}),'--project':option('directory','Project with the installed hooks.',{required:true})},detail:'Edited or untracked chill hooks are left unchanged and reported. Does not stop a native run or erase existing delivery records.'},
  'setup prepare':{label:'chill-setup prepare',summary:'Copy the runtime outside the plugin cache and install a stable project Hook.',options:{'--project':option('directory','Current project directory.',{required:true}),'--isolated':option(null,'Use a dedicated store for this project, even from a bound launcher.'),'--extensions':option('IDs','Isolated project: comma-separated extension IDs, or none. Omit to preserve selection.'),'--harness':harness,'--version-file':option('file','Absolute path of the application\'s cli.json, {"package": "<npm package spec>"}. Recorded so Web startup and its update button follow it.'),'--agent-guide':option('file','Markdown entry of the application\'s agent guide, recorded with --version-file.')},detail:`Returns JSON including the exact reusable command prefix and proposed local URL. Use the prefix as "chill".
Fresh setup isolates the real project folder, including data, port and extension settings.
An explicitly bound data directory is preserved unless --isolated is used.
Start the server with the returned prefix; its startup URL is authoritative.
For --harness claude-code, installs experimental project-local hooks only. Review
them in native /hooks, then establish SessionStart by native resume of the same
conversation if needed. Status reports configuration, not live activation.
Setup never enables Auto mode or changes native permissions. Windows Claude integration is not qualified.
The runtime is stored in immutable runtime/packages/<hash> copies. Re-running
prepare selects the new copy without deleting old copies used by active servers.
It preserves other project hooks and does not change Codex trust records. If
Codex blocks the new Hook, ask the user to review that definition in /hooks.
It does not start/restart a server, expose a URL, or change saved preferences.
Start with the returned command's --help, then settings show and server status.
Use server start --configured when not running; saved remote preferences apply.
Open http://127.0.0.1:<PORT>/#/goal/<id> using the host's browser tool after creating a Goal.`,examples:["node <plugin-root>/bin/chill-setup.mjs prepare --project /path/to/project"]},
  foreground:{label:'node server.mjs',summary:'Run the Web server in the foreground.',options:serverOptions,atMostOne:[['--tunnel','--configured','--local']],detail:`${serverDetail}\nPORT=0 is allowed here to choose a free port. Ctrl+C stops this process.`},
  link:{label:'chill-link',summary:'Use the prepared core from the message-setup plugin.',children:['settings','server'],detail:'Run with node <plugin-root>/bin/chill-link.mjs. Use the same CHILL_AGENT_DATA_DIR\nas core. Commands require the core installation; help works before setup.\nIf core is missing, install and run the chill-agent Skill first.'},
};

// Optional command descriptions are supplied by the composing package.
try {
 const manifest=JSON.parse(readFileSync(new URL('../extensions.json',import.meta.url),'utf8'));
 for(const [name,description] of Object.entries(manifest.help||{})){
  if(!/^[a-z][a-z0-9-]*$/.test(name)||commands[name])throw Error('Invalid extension help');
  commands[name]=description;commands[''].children.push(name);
 }
}catch(e){if(e.code!=='ENOENT')throw e;}

function specFor(path) {
  if (path.startsWith('link ')) path = path.slice(5);
  const spec = Object.hasOwn(commands, path) ? commands[path] : null;
  if (!spec) throw new Error(`Unknown command: ${path}. Use --help to list commands.`);
  return spec;
}
export function formatHelp(path = '') {
  const spec = specFor(path);
  const label = spec.label || (path.startsWith('link ') ? `chill-link ${path.slice(5)}` : `chill${path ? ` ${path}` : ''}`);
  const lines = [spec.summary, '', `Usage: ${label}${spec.children ? ' <command>' : ''}${spec.options ? ' [options]' : ''}`, ''];
  if (spec.children) {
    lines.push('Commands:');
    for (const name of spec.children) {
      const child = specFor(path ? `${path} ${name}` : name);
      lines.push(`  ${name.padEnd(16)} ${child.summary}`);
    }
    lines.push('', `Read more: ${label} <command> --help`, '');
  }
  if (spec.options) {
    lines.push('Options:');
    for (const [name, o] of Object.entries(spec.options)) {
      lines.push(`  ${name}${o.value ? ` <${o.value}>` : ''}${o.required ? ' (required)' : ''}`,
        `    ${o.description}${o.choices ? ` Values: ${o.choices.join(', ')}.` : ''}${o.defaultText ? ` Default: ${o.defaultText}.` : ''}`);
    }
    for (const group of spec.exactlyOne || []) lines.push(`  Supply exactly one of ${group.join(', ')}.`);
    for (const group of spec.atMostOne || []) lines.push(`  Supply at most one of ${group.join(', ')}.`);
    lines.push('');
  }
  if (spec.detail) lines.push(spec.detail, '');
  if (spec.examples) lines.push('Examples:', ...spec.examples.map(line => `  ${path.startsWith('link ') ? line.replace(/^chill /, 'chill-link ') : line}`), '');
  lines.push('Help: --help, -h, or help [command]. No state is changed.');
  return lines.join('\n');
}

export function showHelp(scope, args) {
  if (!args.some(arg => arg === '--help' || arg === '-h') && args[0] !== 'help') return false;
  const parts = [...args];
  if (parts[0] === 'help') parts.shift();
  const path = scope ? [scope] : [];
  for (const part of parts) {
    if (part.startsWith('-')) break;
    path.push(part);
  }
  console.log(formatHelp(path.join(' ')));
  return true;
}

export function parseOptions(path, args) {
  const spec = specFor(path), supported = spec.options || {}, values = {};
  const fail = message => { throw new Error(`${message}\nUsage: ${spec.label || `chill ${path}`} --help`); };
  for (let i = 0; i < args.length; i++) {
    const name = args[i], o = Object.hasOwn(supported, name) ? supported[name] : null;
    if (!o) fail(`Unknown option: ${name}`);
    if (Object.hasOwn(values, name)) fail(`Duplicate option: ${name}`);
    if (o.value) {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`Expected a value for ${name}.`);
      values[name] = value;
      if (o.choices && !o.choices.includes(value)) fail(o.error || `${name} must be ${o.choices.join(' or ')}.`);
    } else values[name] = true;
  }
  for (const [name, o] of Object.entries(supported)) {
    if (o.required && !Object.hasOwn(values, name)) fail(o.error || `${name} is required.`);
  }
  for (const group of spec.exactlyOne || []) if (group.filter(name => Object.hasOwn(values,name)).length !== 1) fail(`Provide exactly one of ${group.join(' or ')}.`);
  for (const group of spec.atMostOne || []) if (group.filter(name => Object.hasOwn(values,name)).length > 1) fail(`Choose only one of ${group.join(', ')}.`);
  return values;
}
