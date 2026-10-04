import {createActivityControls} from './activity-controls.js';
import {createAgentMenu} from './agent-menu.js';
import {createExtensionButtons} from './extension-buttons.js';
import {letterState} from './letter-state.js';
import { workProgressGroups, workDisclosure } from './work-ui.js';
import { createGoalView } from './goal-view.js';
import { createBriefArrivalTracker } from './brief-navigation.js';
import { briefBody } from './brief-body.js';
import {renderDiagrams, annotationOffset, annotationTextNodes} from './markdown-view.js';
import { createConversationWindow, EXPANSION_COMMENT_COUNT } from './conversation-window.js';

const briefsByGoal = new Map();
const goalMetadata = new Map();
const events = [];
const latestBrief = id => briefsByGoal.get(id)?.at(-1);
const latestVersion = id => latestBrief(id)?.version || 0;
const briefAt = (id, version) => briefsByGoal.get(id)?.find(brief => brief.version === version);
const versionRoute = (id,version) => `#/goal/${id}/v${version}`;

const icons = {
  arrow: '<path d="m9 5 7 7-7 7"/>',
  open: '<path d="M14 4h6v6M20 4 10 14M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  comment: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/>',
  letter: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  pending: '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/>',
  annotate: '<path d="M4 20h16M5 16l11-11 3 3L8 19H5v-3Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1"/><path d="m4 17 5-5 3 3 3-4 5 6"/>',
  expandOlder: '<path d="M12 16V4m-5 5 5-5 5 5M4 20h16"/>',
  expandNewer: '<path d="M12 8v12m-5-5 5 5 5-5M4 4h16"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${icons[name]}</svg>`;
const agentAvatar = () => `<svg class="agent-avatar" viewBox="0 0 40 40" fill="none" aria-hidden="true">
  <path d="M20 9V5l4-2" stroke="#373e42" stroke-width="1.8"/><circle cx="25" cy="3" r="2.5" fill="#e4b854"/>
  <rect x="3.5" y="8.5" width="33" height="29" rx="12" fill="#f3d486" stroke="#373e42" stroke-width="1.5"/>
  <rect x="7" y="14" width="26" height="18" rx="8" fill="#fff9e9"/>
  <path d="M3 20v7m34-7v7" stroke="#373e42" stroke-width="3"/>
  <ellipse cx="10.5" cy="25" rx="2.5" ry="1.5" fill="#efb3a4"/><ellipse cx="29.5" cy="25" rx="2.5" ry="1.5" fill="#efb3a4"/>
  <circle cx="14" cy="21" r="1.8" fill="#373e42"/><circle cx="26" cy="21" r="1.8" fill="#373e42"/>
  <path d="M17 26q3 3 6 0" stroke="#373e42" stroke-width="1.7" stroke-linecap="round"/>
  </svg>`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const main = document.querySelector('#main');
const announcement = document.querySelector('#announcement');
let toastTimer;
function showToast(text) {
  announcement.textContent=text;
  const toast=document.getElementById('toast');toast.textContent=text;toast.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},4000);
}
const submitting = new Set();
const commentDrafts = new Map();
const noteDrafts = new Map();
const pendingImages = new Map();
const imageReads = new Map();
const openDetails = new Set();
const openReplies = new Set();
const conversationWindow = createConversationWindow();
const conversationFor = id => events.filter(event => event.goalId === id);
function letterTitle(id) {return events.find(e=>e.id===id)?.title||`Letter #${id}`;}
let pendingUpdateId = null;
const hasNewBrief = createBriefArrivalTracker();
const updateNotice = document.querySelector('#update-notice');
const updateNoticeText = document.querySelector('#update-notice-text');
const viewUpdate = document.querySelector('#view-update');
let currentRoute = '';
let activeGoalId = null;
const agentButton=document.getElementById('agent-button');
agentButton.innerHTML=agentAvatar();
const agentMenu=createAgentMenu({button:agentButton,panel:document.getElementById('agent-panel'),content:document.getElementById('agent-content'),getGoalId:()=>activeGoalId});
const extensionButtons=createExtensionButtons({container:document.getElementById('extension-buttons'),getGoalId:()=>activeGoalId,announce:showToast});
let activeVersion = null;
let pendingAnchor = null;
let annotationOpen = false;
let editingNote = null;
const annotationSaves = new Set();
const imageNames = new Map();
const visibleNotes = new Map();
const draftKey = (type, id) => `chill-workspace:${type}:${id}`;
function readDraft(type, id) {
  try { return localStorage.getItem(draftKey(type, id)) || ''; } catch { return ''; }
}
function writeDraft(type, id, value) {
  try { if (value) localStorage.setItem(draftKey(type, id), value); else localStorage.removeItem(draftKey(type, id)); } catch { /* Private browsing may block storage. */ }
}
const formKey = (id, type) => `${id}:${type}`;
const imagesFor = type => pendingImages.get(formKey(activeGoalId, type)) || [];
const attachmentIdsFor = item => item?.attachmentIds || [];
const notesKey = (id = activeGoalId) => formKey(id, 'notes');
function notesFor(id = activeGoalId) {
  const key = notesKey(id);
  if (!noteDrafts.has(key)) {
    try {
      const stored = JSON.parse(readDraft('notes', id));
      noteDrafts.set(key, Array.isArray(stored) ? stored : []);
    }
    catch { noteDrafts.set(key, []); }
  }
  return noteDrafts.get(key);
}
function saveNotes(notes, id = activeGoalId) {
  noteDrafts.set(notesKey(id), notes);
  // A local file preview disappears on reload, so its notes cannot be restored alone.
  writeDraft('notes', id, JSON.stringify(notes.filter(note => note.target !== 'attachment')));
}
function noteLabel(note) {
  if(note.kind==='letter')return letterTitle(note.source.eventId);
  return note.kind === 'text' ? note.anchor.quote : note.imageName || imageNames.get(note.imageId) || 'Image';
}
const selectedNotes = (id = activeGoalId) => notesFor(id).filter(note => note.selected !== false);
const noteSourceLabel = note => note.kind==='letter'?'Letter · ':note.kind === 'text' ? (note.source?.kind === 'comment' ? `${note.source.field==='title'?'Letter title':'Agent'} #${note.source.eventId} · ` : `Brief v${note.source?.version} · `) : '';
function noteImageMarkup(note, preview = false) {
  return attachmentIdsFor(note).map(id => {
    const src = `/api/images/${escapeHTML(id)}`;
    const img = `<img class="${preview ? 'note-image' : 'note-thumbnail'}" src="${src}" alt="Note attachment">`;
    return preview ? `<a href="${src}" target="_blank" rel="noopener" aria-label="Open note image">${img}</a>` : img;
  }).join('');
}
function notesPanelMarkup(id) {
  const notes = notesFor(id);
  if (!notes.length) return '';
  const count = selectedNotes(id).length;
  return `<div class="notes-panel"><div class="notes-heading"><strong>Annotations <span>${count}/${notes.length}</span></strong>
    <label class="note-check"><input type="checkbox" data-note-all ${count === notes.length ? 'checked' : ''}>All</label></div>
    <ol>${notes.map(note => `<li class="draft-note ${note.selected === false ? 'is-excluded' : ''}">
      <label class="note-check"><input type="checkbox" data-note-toggle="${escapeHTML(note.id)}" ${note.selected === false ? '' : 'checked'} aria-label="Send note: ${escapeHTML(noteLabel(note))}"></label>
      <button type="button" data-action="edit-draft-note" data-note-id="${escapeHTML(note.id)}" title="Open note"><span class="note-target">${escapeHTML(noteSourceLabel(note) + noteLabel(note))}</span><span class="note-summary">${escapeHTML(note.text || (attachmentIdsFor(note).length ? 'Image' : ''))}</span>${noteImageMarkup(note)}${icon('open')}</button>
      <button type="button" class="note-remove" data-action="delete-draft-note" data-note-id="${escapeHTML(note.id)}" aria-label="Delete note: ${escapeHTML(noteLabel(note))}" title="Delete note">${icon('close')}</button></li>`).join('')}</ol></div>`;
}
function updateComposerState() {
  const form = main.querySelector('.conversation-form');
  if (!form) return;
  const busy = submitting.has(formKey(activeGoalId, 'comment')) || annotationSaves.has(notesKey()) || imageReads.has(formKey(activeGoalId, 'comment'));
  form.querySelector('fieldset').disabled = busy;
  const empty = !form.querySelector('textarea').value.trim() && !imagesFor('comment').length && !selectedNotes().length;
  form.querySelectorAll('[data-submit-mode]').forEach(button => {
    button.disabled = busy;
  });
  if (!empty) {
    form.querySelector('.empty-reply')?.remove();
    form.querySelector('textarea').removeAttribute('aria-invalid');
  }
  const all = form.querySelector('[data-note-all]');
  if (all) all.indeterminate = selectedNotes().length > 0 && selectedNotes().length < notesFor().length;
}
function updateNotesPanel() {
  const focused = document.activeElement;
  const focusNoteId = focused?.dataset.noteToggle;
  const focusAll = focused?.hasAttribute('data-note-all');
  const slot = main.querySelector('[data-notes-slot]');
  if (slot) slot.innerHTML = notesPanelMarkup(activeGoalId);
  const nextFocus = focusAll ? slot?.querySelector('[data-note-all]')
    : [...(slot?.querySelectorAll('[data-note-toggle]') || [])].find(input => input.dataset.noteToggle === focusNoteId);
  nextFocus?.focus({preventScroll: true});
  updateComposerState();
}

function savedNotesMarkup(event) {
  if (!event.annotations?.length) return '';
  return `<ol class="event-notes">${event.annotations.map((note, index) => `<li><button type="button" data-action="locate-note" data-note-ref="event-${event.id}-${index}">
    <span class="note-target">${escapeHTML(noteSourceLabel(note) + noteLabel(note))}</span><span class="note-summary">${escapeHTML(note.text || (attachmentIdsFor(note).length ? 'Image' : ''))}</span>${noteImageMarkup(note)}${icon('arrow')}</button></li>`).join('')}</ol>`;
}

function composerMarkup(id, comment) {
  return `<form class="conversation-form" data-form="comment" data-goal-id="${id}"><fieldset>
    <legend class="sr-only">Comment on this Goal</legend>
    <div class="comment-field"><label class="sr-only" for="conversation-comment">Reply</label>
      <textarea id="conversation-comment" data-input="comment" rows="3" maxlength="10000" placeholder="Write a comment">${escapeHTML(comment)}</textarea></div>
    ${imageControl('comment')}<div data-notes-slot>${notesPanelMarkup(id)}</div>
    <div class="composer-actions"><div class="composer-buttons">${imagePicker('comment')}<button type="submit" class="composer-submit comment" data-submit-mode="comment">${icon('comment')}Comment</button></div></div>
  </fieldset></form>`;
}

const deliveries = new Map();
const activityControls=createActivityControls({main,getGoalId:()=>activeGoalId,onChange:()=>{
 if(activeGoalId)updateTimeline(activeGoalId);
 void refreshGoals().catch(()=>{});
}});
const workViews = new Map();
function workMarkup(work) {
  if (!work) return '';
  const view = workDisclosure(workViews.get(work.key), work.live);
  workViews.set(work.key, view);
  return `<details class="work-progress" data-work-id="${escapeHTML(work.key)}" ${view.open ? 'open' : ''}>
    <summary>Think</summary><div class="work-output" aria-label="Think">
    ${work.messages.map(message => `<p class="work-message" lang="ja">${escapeHTML(message.text)}</p>`).join('')}
    ${work.error ? '<p class="work-hint">Updates unavailable. Saved output is kept.</p>' : !work.messages.length ? '<p class="work-hint">Waiting for updates.</p>' : ''}
    ${work.truncated ? '<p class="work-hint">Showing latest updates.</p>' : ''}
    </div></details>`;
}
function deliveryMarkup(event, work, continuedTo) {
  const delivery = deliveries.get(event.changeId);
  const activity=activityControls.forEvent(event.changeId);
  if(activity)continuedTo=null;
  if (!delivery && !event.threadId && !activity) return '';
  const state = activity?activity.status:continuedTo ? 'continued' : delivery?.status || 'saved';
  if(activity?.work)work={key:work?.key||`continued-${event.changeId}`,live:activity.status==='working',...activity.work};
  const labels = { saved: 'Saved', sending: 'Sending', queued: 'Queued', received: 'Received', working: 'Running', paused:'Paused', continued: 'Continued', completed: 'Done', failed: 'Needs attention', unknown: 'Delivery unconfirmed', unlinked: 'Saved' };
  const descriptions = { saved: '', sending: '', queued: '', received: '', working: '', paused:activity?.holdId?'Add a comment to resume together.':'Queue paused.', continued: 'Included in the follow-up below.', completed: '', failed: delivery?.error || 'Could not send. Your reply is saved.', unknown: 'Your reply is saved. Check before sending again.', unlinked: 'Saved locally. No chat is assigned to this Goal.' };
  const retry = state === 'saved' || (state === 'failed' && !delivery?.mayHaveSent);
  const check = state === 'unknown';
  const history = delivery?.history || [];
  return `<li class="timeline-event delivery-event" id="delivery-${event.changeId}">
    <span class="timeline-marker agent" aria-hidden="true">${agentAvatar()}</span>
    <div class="delivery-entry" data-state="${state}"><div class="delivery-heading"><span class="delivery-dot" aria-hidden="true"></span><strong>${activity&&state==='unknown'?'Checking':labels[state] || 'Saved'}</strong>
      ${continuedTo ? `<button type="button" class="text-button" data-action="view-work" data-event-id="${continuedTo}" aria-label="View continued work">View ↓</button>` : ''}
      ${activity?activityControls.markup(event.changeId):''}
      ${!activity && (retry || check) ? `<button type="button" class="text-button" data-action="retry-delivery" data-event-id="${event.changeId}" data-goal-id="${event.goalId}">${check ? 'Check' : 'Retry'}</button>` : ''}</div>
      <p>${escapeHTML(activity&&state==='unknown'?'Unconfirmed. Refresh to check.':descriptions[state] || '')}</p>
      ${workMarkup(work)}
      ${history.length ? `<details class="delivery-history" data-delivery-id="${event.changeId}" ${openDeliveries.has(event.changeId) ? 'open' : ''}><summary>Activity</summary>${delivery?.work?.settings?.model ? `<p class="activity-settings">${escapeHTML(delivery.work.settings.model)}${delivery.work.settings.reasoning ? ` · ${escapeHTML(delivery.work.settings.reasoning)}` : ''}</p>` : ''}<ol>${history.map(item => `<li><span>${escapeHTML(labels[item.status] || item.status)}</span><time datetime="${escapeHTML(item.at)}">${new Date(item.at).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'})}</time></li>`).join('')}</ol></details>` : ''}
    </div></li>`;
}

function replyMarkup(event) {
  const source = event.author === 'agent' ? `data-annotation-reply="${event.id}"` : '';
  return `<div class="event-text markdown-body" ${source} lang="ja">${briefBody(event.html || '', event.id, openReplies)}</div>`;
}

function timelineMarkup(id) {
  const visible = conversationFor(id);
  const work = workProgressGroups(visible, deliveries);
  // Keep each receipt in the timeline, but only its shared turn's last entry
  // owns the running indicator and Think. Delivery records remain unchanged.
  const continued = new Map([...work.values()].flatMap(group => group.eventIds
    .filter(eventId => eventId !== group.owner).map(eventId => [eventId, group.owner])));
  const pinned = conversationPins(id, visible);
  for (const group of work.values()) if (group.live) pinned.add(group.owner);
  const activity=activityControls.current();if(activity&&['saved','sending','queued','working','paused','unknown'].includes(activity.status))pinned.add(activity.eventId);
  return conversationWindow.segments(id, visible, pinned).map(segment => {
    if (segment.kind === 'gap') {
      const count = segment.messages.length, first = segment.messages[0].id, last = segment.messages.at(-1).id;
      const step = Math.min(EXPANSION_COMMENT_COUNT,count);
      const control = side => `<button type="button" data-action="expand-conversation" data-side="${side}" data-first-id="${first}" data-last-id="${last}" aria-label="Show ${step} ${side==='top'?'earlier':'later'} ${step===1?'comment':'comments'}"><span class="conversation-gap-marker" aria-hidden="true">${icon(side==='top'?'expandOlder':'expandNewer')}</span></button>`;
      const controls = `${control('top')}${control('bottom')}<span class="conversation-gap-summary">${count} more ${count===1?'comment':'comments'}</span>`;
      return `<li class="conversation-gap" data-gap-first="${first}" data-gap-last="${last}"><div class="conversation-gap-controls">${controls}</div></li>`;
    }
    return segment.messages.map(event => {
    const letter=letterState(event,visible);
    const time=`<time datetime="${event.at.toISOString()}">${event.at.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>`;
    return `<li id="event-${event.id}" class="timeline-event comment-event">
      <span class="timeline-marker ${event.author}" aria-hidden="true">${event.author==='agent'?agentAvatar():icon('comment')}</span>
      <article class="timeline-entry${letter?` letter-comment ${letter.status!=='open'?'is-answered':''}`:''}">${letter?`<header class="letter-comment-heading"><h3 class="letter-comment-title">${icon('letter')}<span data-annotation-reply="${event.id}" data-reply-field="title">${escapeHTML(event.title)}</span></h3><div class="letter-comment-meta">${letter.status!=='open'?`<span class="answered-label">${letter.status==='received'?'Received':'Replied'}</span>`:''}${time}</div></header>`:`<header class="event-meta"><strong>${event.author==='agent'?'Agent':'You'}</strong>${time}</header>`}
      ${event.text?replyMarkup(event):''}
      ${savedNotesMarkup(event)}${attachmentIdsFor(event).map(id=>`<a class="event-image-link" href="/api/images/${escapeHTML(id)}" target="_blank" rel="noopener" aria-label="Open attached image"><img class="event-image" src="/api/images/${escapeHTML(id)}" alt="Attached image"></a>`).join('')}${letter?`<button type="button" class="action letter-answer-toggle" data-action="answer-letter" data-letter-id="${event.id}">Answer</button>`:''}</article></li>${event.author==='user'?deliveryMarkup(event,work.get(event.changeId),continued.get(event.changeId)):''}`;
    }).join('');
  }).join('');
}

function conversationPins(id, messages = conversationFor(id)) {
  const pinned = new Set();
  const activity=activityControls.current();if(activity&&['saved','sending','queued','working','paused','unknown'].includes(activity.status))pinned.add(activity.eventId);
  for (const note of notesFor(id)) if(note.source?.kind==='comment')pinned.add(note.source.eventId);
  return pinned;
}
function updateConversationControls(id) {
  const button=main.querySelector('[data-action="collapse-conversation"]');
  if(button)button.hidden=!conversationWindow.canCollapse(id,conversationFor(id),conversationPins(id));
}
function revealConversationEvent(eventId) {
  if (!activeGoalId || !conversationFor(activeGoalId).some(e => e.id === eventId)) return;
  if (!document.getElementById(`event-${eventId}`)) {
    conversationWindow.reveal(activeGoalId,conversationFor(activeGoalId),eventId);
    updateTimeline(activeGoalId);renderAnnotations();
  }
}

let timelineRefreshPending = false;
function interactingWithAnnotation() {
  const selection = selectedText();
  return annotationOpen || imageAreaDialog.open || submitting.size>0 || (selection && !selection.isCollapsed && (main.contains(selection.anchorNode)||briefRoot()?.contains(selection.anchorNode)));
}
function updateTimeline(id) {
  if (interactingWithAnnotation()) { timelineRefreshPending = true; return; }
  timelineRefreshPending = false;
  const timeline = main.querySelector('#timeline-list');
  if (!timeline) return;
  const controlFocus=document.activeElement?.closest('[data-activity-control]')?.closest('.delivery-event')?.id;
  const focused = document.activeElement?.closest('[data-work-id], [data-reply-detail]');
  const focusKey = focused?.dataset.workId;
  const replyFocusKey = focused?.dataset.replyDetail;
  const foldFocus=document.activeElement?.closest('[data-action="expand-conversation"], [data-action="collapse-conversation"]')?.dataset;
  const paneTop=main.getBoundingClientRect().top;
  const anchor=[...timeline.children].find(item=>item.getBoundingClientRect().bottom>paneTop)
    || main.querySelector('.conversation-form');
  const anchorId=anchor?.id,anchorTop=anchor?.getBoundingClientRect().top;
  const gapFirst=anchor?.dataset.gapFirst,gapLast=anchor?.dataset.gapLast;
  timeline.innerHTML = timelineMarkup(id);
  const retained=anchorId?document.getElementById(anchorId):gapFirst
    ?timeline.querySelector(`[data-gap-first="${gapFirst}"][data-gap-last="${gapLast}"]`)
    :main.querySelector('.conversation-form');
  if(retained)main.scrollTop+=retained.getBoundingClientRect().top-anchorTop;
  if(controlFocus)document.getElementById(controlFocus)?.querySelector('[data-activity-control]')?.focus({preventScroll:true});
  void renderDiagrams(timeline);
  updateConversationControls(id);
  if(foldFocus) {
    const control=foldFocus.action==='collapse-conversation'?main.querySelector('[data-action="collapse-conversation"]')
      :timeline.querySelector(`[data-first-id="${foldFocus.firstId}"][data-last-id="${foldFocus.lastId}"][data-side="${foldFocus.side}"]`);
    if(control&&!control.hidden)control.focus({preventScroll:true});
  }
  for (const detail of timeline.querySelectorAll('[data-work-id]')) {
    if (detail.dataset.workId === focusKey) detail.querySelector('summary').focus({preventScroll: true});
  }
  for (const detail of timeline.querySelectorAll('[data-reply-detail]')) {
    if (detail.dataset.replyDetail === replyFocusKey) detail.querySelector('summary').focus({preventScroll: true});
  }
}

const expandedGoals=new Set();
function goalView() {
  const goals=Object.fromEntries([...goalMetadata].map(([id,goal])=>[id,{...goal,
    briefs:briefsByGoal.get(id)||[],conversation:events.filter(e=>e.goalId===id),
    children:[...goalMetadata.values()].filter(g=>g.parentId===id).map(g=>g.id)}]));
  return createGoalView(goals,activeGoalId,expandedGoals);
}
function refreshGoalFrame() {
  updateBrandTarget();
  const slot=main.querySelector('#goal-frame');
  if(slot&&activeGoalId)slot.innerHTML=goalView().brief(activeGoalId);
}
function renderGoal(id,version) {
  const brief=briefAt(id,version),isHTML=brief?.format==='html',body=isHTML?'':briefBody(brief?.html||''),view=goalView();
  const imageTemplate=document.createElement('template');imageTemplate.innerHTML=body;
  imageNames.clear();
  imageTemplate.content.querySelectorAll('img').forEach((img,index)=>{
    const imageId=imageIdFromSource(img.getAttribute('src'));
    if(imageId)imageNames.set(imageId,(img.title||img.alt||`Image ${index+1}`).slice(0,200));
  });
  const key=formKey(id,'comment');
  const comment=commentDrafts.get(key)??readDraft('comment',id);commentDrafts.set(key,comment);
  document.title=`${goalMetadata.get(id).title} · chill`;
  main.innerHTML=`<div id="goal-frame">${view.brief(id)}</div><div class="history-grid">
    <section class="document-section"><div class="section-heading document-heading"><h2>Brief</h2>${brief?view.pager(id,version):''}</div>
      <article class="surface document-card brief${isHTML?' html-brief':''}" aria-label="Brief">
        <div class="brief-body markdown-body" lang="ja" ${isHTML?'hidden':''}>${body||'<p class="empty-state">No Brief yet. You can start the conversation below.</p>'}</div>
      </article>${brief&&version<latestVersion(id)?`<div class="history-notice"><span>Earlier Brief</span><a href="${versionRoute(id,latestVersion(id))}">View current →</a></div>`:''}
    </section>
    <form class="annotation-form" data-form="annotation" data-goal-id="${id}" data-version="${version}" hidden><fieldset>
      <div class="annotation-heading"><strong data-editor-heading>Annotation</strong><button type="button" class="text-button" data-action="close-annotation" aria-label="Close annotation">✕</button></div><blockquote class="annotation-quote"></blockquote>
      <div class="comment-field"><label class="sr-only" for="annotation-comment">Annotation</label><textarea id="annotation-comment" data-input="annotation" rows="2" placeholder="Add a note" maxlength="2000"></textarea></div>
      <div data-note-image-slot>${imageControl('annotation')}</div><div class="comment-submit"><button type="button" class="text-button note-delete" data-action="delete-note" hidden>Delete</button>${imagePicker('annotation')}<button class="action action-primary" type="submit" value="save">Save</button><button class="action action-primary note-comment" type="submit" value="comment" hidden>Comment</button></div>
    </fieldset></form>
    <section class="conversation"><div class="section-heading conversation-heading"><h2>Conversation</h2><button type="button" class="text-button" data-action="collapse-conversation" hidden>Collapse earlier</button></div>
      <ol class="timeline" id="timeline-list" aria-label="Conversation">${timelineMarkup(id)}</ol>${composerMarkup(id,comment)}</section></div>`;
  const briefReady=isHTML?mountHTMLBrief(id,version):Promise.resolve();
  updateComposerState();updateConversationControls(id);renderAnnotations();
  return Promise.all([briefReady,renderDiagrams(main)]);
}

function htmlBriefFrame() {return main.querySelector('.html-brief-frame');}
function briefRoot() {return htmlBriefFrame()?.contentDocument?.querySelector('.brief-body')||main.querySelector('.brief-body');}
function annotationSources(selector) {
  return [...main.querySelectorAll(selector),...(htmlBriefFrame()?.contentDocument?.querySelectorAll(selector)||[])];
}
function selectedText() {
  const local=htmlBriefFrame()?.contentWindow?.getSelection();
  return local&&!local.isCollapsed?local:window.getSelection();
}
function clearSelections() {window.getSelection()?.removeAllRanges();htmlBriefFrame()?.contentWindow?.getSelection()?.removeAllRanges();}
function viewportRect(element) {
  const rect=element.getBoundingClientRect(),frame=htmlBriefFrame();
  if(!frame||element.ownerDocument===document)return rect;
  const offset=frame.getBoundingClientRect();
  return {left:rect.left+offset.left,right:rect.right+offset.left,top:rect.top+offset.top,bottom:rect.bottom+offset.top};
}
function scrollInReadingPane(target,block='center') {
  if(!target?.isConnected)return;
  // scrollIntoView also moves overflow:hidden ancestors, including the viewport.
  // Keep the fixed shell in place and scroll only the reading pane.
  const rect=viewportRect(target),pane=main.getBoundingClientRect();
  const top=pane.top+main.clientTop+12,bottom=pane.top+main.clientTop+main.clientHeight-12;
  if(block==='center')main.scrollTop+=(rect.top+rect.bottom-top-bottom)/2;
  else if(rect.top>=top&&rect.bottom<=bottom||rect.top<top&&rect.bottom>bottom)return;
  else main.scrollTop+=rect.top<top?rect.top-top:rect.bottom-bottom;
}
function mountHTMLBrief(id,version) {
  const frame=document.createElement('iframe');frame.className='html-brief-frame';frame.title='HTML Brief';
  frame.setAttribute('sandbox','allow-same-origin');frame.src=`/api/goals/${id}/briefs/${version}/document`;
  let ready;const loaded=new Promise(resolve=>{ready=resolve;});
  frame.addEventListener('load',async()=>{
    if(!frame.isConnected){ready();return;}
    const doc=frame.contentDocument,body=doc?.querySelector('.brief-body');if(!body){ready();return;}
    const size=()=>{if(frame.isConnected)frame.style.height=`${Math.ceil(Math.max(body.getBoundingClientRect().height,body.scrollHeight))+1}px`;};
    const observer=new ResizeObserver(size);observer.observe(body);
    for(const type of ['wheel','touchmove','keydown'])doc.addEventListener(type,briefScrollIntent,{passive:true});
    doc.addEventListener('selectionchange',updateSelectionAction);
    // Do not rely only on selectionchange timing across frame focus changes.
    // Read the completed selection as well, without moving focus out of the Brief.
    doc.addEventListener('pointerup',updateSelectionAction);
    doc.addEventListener('keyup',updateSelectionAction);
    doc.addEventListener('click',event=>{
      const mark=event.target.closest('.annotation-mark, .image-note-box');
      if(mark){event.preventDefault();openNoteReference(mark.dataset.noteRef);return;}
      const link=event.target.closest('a[href]');if(link){event.preventDefault();window.open(link.href,'_blank','noopener,noreferrer');}
      const image=event.target.closest('[data-action="annotate-image"]');if(image)openImageSelection(image.dataset.imageId);
    });
    doc.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('.annotation-mark')){event.preventDefault();event.target.click();}});
    renderAnnotations();size();
    // Stop observers when the route replaces this frame.
    const cleanup=new MutationObserver(()=>{if(!frame.isConnected){observer.disconnect();cleanup.disconnect();}});
    cleanup.observe(main,{childList:true,subtree:true});
    await doc.fonts.ready;size();ready();
  });
  main.querySelector('.html-brief').append(frame);
  return loaded;
}

function imagePreviewMarkup(type) {
  const saved = type === 'annotation' ? attachmentIdsFor(editingNote).map(id => ({id, url: `/api/images/${id}`})) : [];
  return [...saved, ...imagesFor(type)].map(image => `<div class="image-card"><img src="${escapeHTML(image.url)}" alt="${escapeHTML(image.file?.name || 'Attached image')}">
    <button type="button" class="image-remove" data-action="remove-image" data-image-type="${type}" data-image-key="${escapeHTML(image.id)}" aria-label="Remove image">×</button></div>`).join('');
}
function imageControl(type) {
  const preview = imagePreviewMarkup(type);
  return `<div class="image-control ${preview ? 'has-image' : ''}" ${preview ? '' : 'hidden'}><div class="image-heading"><strong>Images</strong></div>
    <div class="image-preview" data-preview-for="${type}">${preview}</div></div>`;
}
function imagePicker(type) {
  return `<label class="image-pick" data-image-picker="${type}" title="Add image">${icon('image')}<span>Add image</span><input type="file" data-image-type="${type}" accept="image/png,image/jpeg,image/webp" multiple class="sr-only"></label>`;
}
function refreshImageControl(type) {
  const control = main.querySelector(`[data-form="${type}"] .image-control`);
  if (control) control.outerHTML = imageControl(type);
  if (type === 'annotation') updateNoteEditorState(); else updateComposerState();
}
function updateNoteEditorState() {
  const form = main.querySelector('.annotation-form');
  if (!form) return;
  const busy = annotationSaves.has(notesKey()) || imageReads.has(formKey(activeGoalId, 'annotation'));
  form.querySelector('fieldset').disabled = busy;
  const empty=!form.querySelector('textarea').value.trim() && !imagesFor('annotation').length && !attachmentIdsFor(editingNote).length;
  form.querySelectorAll('[type="submit"]').forEach(button=>{button.disabled=busy||empty;});
}

async function setPendingImages(type, files) {
  const form = main.querySelector(`[data-form="${type}"]`);
  if (!form) return;
  const key = formKey(activeGoalId, type);
  if (imageReads.has(key) || form.querySelector('fieldset').disabled) return;
  form.querySelector('.save-error')?.remove();
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    showSaveError(form, new Error('Use a PNG, JPEG, or WebP image up to 5 MB.'));
    return;
  }
  const savedCount = type === 'annotation' ? attachmentIdsFor(editingNote).length : 0;
  if (savedCount + imagesFor(type).length + files.length > 30) {
    showSaveError(form, new Error('Use at most 30 images per message or note.'));
    return;
  }
  const id = activeGoalId;
  const request = Symbol();
  imageReads.set(key, request);
  if (type === 'annotation') updateNoteEditorState(); else updateComposerState();
  try {
    // Snapshot while the file picker still exists. Mobile photo providers can
    // invalidate the original File before a later fetch tries to read it.
    const snapshots = await Promise.all(files.map(async file => new File([await file.arrayBuffer()], file.name, {type: file.type, lastModified: file.lastModified})));
    if (imageReads.get(key) !== request) return;
    pendingImages.set(key, [...(pendingImages.get(key) || []), ...snapshots.map(file => ({id: crypto.randomUUID(), file, url: URL.createObjectURL(file)}))]);
    if (activeGoalId === id && form.isConnected) {
      refreshImageControl(type);
      renderAnnotations();
    }
  } catch {
    if (imageReads.get(key) === request && activeGoalId === id && form.isConnected) {
      showSaveError(main.querySelector(`[data-form="${type}"]`), new Error('Could not read this image. Please select it again.'));
    }
  } finally {
    if (imageReads.get(key) === request) {
      imageReads.delete(key);
      if (activeGoalId === id && form.isConnected) {
        const input = main.querySelector(`[data-image-picker="${type}"] input`);
        if (input) input.value = '';
        if (type === 'annotation') updateNoteEditorState(); else updateComposerState();
      }
    }
  }
}

function removePendingImage(type, id = activeGoalId) {
  const key = formKey(id, type);
  imageReads.delete(key);
  const previous = pendingImages.get(key);
  for (const image of previous || []) URL.revokeObjectURL(image.url);
  pendingImages.delete(key);
  if (activeGoalId !== id) return;
  const input = main.querySelector(`[data-image-picker="${type}"] input`);
  if (input) input.value = '';
  if (type === 'comment' && previous && notesFor().some(note => note.target === 'attachment')) {
    saveNotes(notesFor().filter(note => note.target !== 'attachment'));
    renderAnnotations();
    updateNotesPanel();
  }
  refreshImageControl(type);
}
function removeImage(type, imageId) {
  const key = formKey(activeGoalId, type);
  const images = imagesFor(type);
  const removed = images.find(image => image.id === imageId);
  if (removed) URL.revokeObjectURL(removed.url);
  pendingImages.set(key, images.filter(image => image.id !== imageId));
  if (type === 'annotation' && editingNote) {
    editingNote.attachmentIds = attachmentIdsFor(editingNote).filter(id => id !== imageId);
  }
  refreshImageControl(type);
}
const uploadedImages = new WeakMap();
async function uploadImage(file) {
  if (uploadedImages.has(file)) return uploadedImages.get(file);
  let response;
  try { response = await fetch('/api/images', {method: 'POST', headers: {'Content-Type': file.type}, body: file}); }
  catch { throw new Error('Image upload could not connect. Your draft is kept. Check the connection and try again.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.id !== 'string') throw new Error(result.error || 'Could not attach image. Please try again.');
  uploadedImages.set(file, result.id);
  return result.id;
}

const annotationAction = document.createElement('button');
annotationAction.type = 'button';
annotationAction.className = 'annotation-action';
annotationAction.setAttribute('aria-label', 'Annotate selected text');
annotationAction.title = 'Annotate selected text';
annotationAction.innerHTML = icon('annotate');
annotationAction.hidden = true;
document.body.append(annotationAction);
function hideAnnotationAction() { annotationAction.hidden = true; }
const annotationPreview = document.createElement('div');
annotationPreview.className = 'annotation-preview';
annotationPreview.hidden = true;
document.body.append(annotationPreview);
function hideAnnotationPreview() { annotationPreview.hidden = true; annotationPreview.innerHTML = ''; }


function selectionAnchor() {
  if (!activeGoalId || annotationOpen || imageAreaDialog.open) return null;
  if (submitting.has(formKey(activeGoalId, 'comment'))) return null;
  const selection = selectedText();
  const startNode = selection?.anchorNode;
  const body = (startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement)?.closest('.brief-body, [data-annotation-reply]');
  if (!body || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  if ((range.startContainer.parentElement?.closest('[data-annotation-ignore]')) || range.endContainer.parentElement?.closest('[data-annotation-ignore]')) return null;
  const base = Number(body.dataset.replyOffset || 0);
  const start = base + annotationOffset(body, range.startContainer, range.startOffset);
  const end = base + annotationOffset(body, range.endContainer, range.endOffset);
  if (end <= start || end - start > 2000) return null;
  const quote = annotationTextNodes(body).map(n => n.textContent).join('').slice(start - base, end - base).trim();
  if (!quote) return null;
  const source = body.dataset.annotationReply ? {kind: 'comment', eventId: Number(body.dataset.annotationReply), ...(body.dataset.replyField==='title'?{field:'title'}:{})} : {kind: 'brief',version:activeVersion};
  return {start, end, quote, source, document:body.ownerDocument, rect: (()=>{const r=range.getBoundingClientRect(),f=htmlBriefFrame();if(body.ownerDocument===document||!f)return r;const p=f.getBoundingClientRect();return {left:r.left+p.left,right:r.right+p.left,top:r.top+p.top,bottom:r.bottom+p.top};})()};
}

let selectionActionTimer;
function updateSelectionAction() {
  clearTimeout(selectionActionTimer);
  selectionActionTimer=setTimeout(() => {
    if (annotationOpen || annotationAction.ownerDocument.activeElement === annotationAction) return;
    const anchor = selectionAnchor();
    if (!anchor) { pendingAnchor = null; return hideAnnotationAction(); }
    pendingAnchor = {start: anchor.start, end: anchor.end, quote: anchor.quote, source: anchor.source};
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const rightEdge = (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth) - 8;
    const right = Math.min(anchor.rect.right, rightEdge);
    const left = Math.max(leftEdge, right - 44);
    if (right - left < 24) return hideAnnotationAction();
    annotationAction.style.width = `${right - left}px`;
    const topEdge = Math.max(main.getBoundingClientRect().top, viewport?.offsetTop || 0) + 8;
    const bottomEdge = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 52;
    if (anchor.rect.bottom < topEdge || anchor.rect.top > bottomEdge + 44) return hideAnnotationAction();
    const top=Math.min(Math.max(anchor.rect.bottom + 8, topEdge), bottomEdge);
    // Paint in the selection's own document. WebKit may not repaint a parent
    // overlay above a focused iframe until the user focuses the parent again.
    if(annotationAction.ownerDocument!==anchor.document)anchor.document.body.append(annotationAction);
    const frame=anchor.document===document?null:htmlBriefFrame();
    const frameRect=frame?.getBoundingClientRect();
    annotationAction.style.position=frame?'absolute':'fixed';
    annotationAction.style.left=`${left-(frameRect?.left||0)}px`;
    annotationAction.style.top=`${frame?Math.min(top-frameRect.top,frame.clientHeight-48):top}px`;
    annotationAction.hidden = false;
  }, 60);
}
document.addEventListener('selectionchange',updateSelectionAction);
annotationAction.addEventListener('pointerdown', event => event.preventDefault());
annotationAction.addEventListener('click', event => {
  event.preventDefault();
  if (!pendingAnchor || !activeGoalId) return;
  hideAnnotationAction();
  const {source, ...anchor} = pendingAnchor;
  openNoteEditor({id: crypto.randomUUID(), kind: 'text', anchor, source, text: ''});
});
function openNoteEditor(note) {
  if (annotationSaves.has(notesKey()) || submitting.has(formKey(activeGoalId, 'comment'))) return;
  removePendingImage('annotation');
  editingNote = structuredClone(note);
  annotationOpen = true;
  const form = main.querySelector('.annotation-form');
  form.querySelector('.save-error')?.remove();
  form.hidden = false;
  const answering=note.kind==='letter';
  form.querySelector('[data-editor-heading]').textContent=answering?'Answer':'Annotation';
  form.querySelector('label[for="annotation-comment"]').textContent=answering?'Answer':'Annotation';
  form.querySelector('[data-action="close-annotation"]').setAttribute('aria-label',answering?'Close answer':'Close annotation');
  form.querySelector('.note-comment').hidden=!answering;
  form.querySelector('.annotation-quote').textContent = noteSourceLabel(note) + noteLabel(note);
  const input = form.querySelector('textarea');
  input.value = note.text;
  input.placeholder=answering?'Write your answer':'Add a note';
  form.querySelector('.note-delete').hidden = !notesFor().some(item => item.id === note.id);
  refreshImageControl('annotation');
  clearSelections();
  renderAnnotations(true);
  // Let the browser reveal the focused field when opening its keyboard.
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function closeAnnotation() {
  closeImageSelection();
  annotationOpen = false;
  pendingAnchor = null;
  editingNote = null;
  removePendingImage('annotation');
  main.querySelector('.annotation-form')?.setAttribute('hidden', '');
  hideAnnotationAction();
  clearSelections();
  renderAnnotations();
}

const imageAreaDialog = document.createElement('dialog');
imageAreaDialog.className = 'image-area-dialog';
imageAreaDialog.setAttribute('aria-labelledby', 'image-area-heading');
imageAreaDialog.innerHTML = `<div class="annotation-heading"><strong id="image-area-heading">Select an area</strong><button type="button" class="text-button" data-area-close aria-label="Close image selection">✕</button></div>
  <p class="image-area-hint">Drag to select. Drag again to redraw.</p>
  <div class="image-area-workspace"><div class="image-area-stage"><img alt="" draggable="false"><span class="image-area-rect" hidden></span></div></div>
  <div class="image-area-actions"><button type="button" class="text-button" data-area-whole>Whole image</button><button type="button" class="action action-primary" data-area-next disabled>Next</button></div>`;
document.body.append(imageAreaDialog);
const imageAreaStage = imageAreaDialog.querySelector('.image-area-stage');
const imageAreaImage = imageAreaStage.querySelector('img');
const imageAreaBox = imageAreaStage.querySelector('.image-area-rect');
const imageAreaNext = imageAreaDialog.querySelector('[data-area-next]');
const imageAreaWhole = imageAreaDialog.querySelector('[data-area-whole]');
let imageSelection = null, imageDrawing = null;

function updateImageSelection() {
  const area = imageSelection?.rect;
  imageAreaBox.hidden = !area;
  if (area) positionArea(imageAreaBox, area);
  imageAreaNext.disabled = !area || Boolean(imageDrawing);
}
function openImageSelection(imageId) {
  if (annotationSaves.has(notesKey()) || submitting.has(formKey(activeGoalId, 'comment'))) return;
  hideAnnotationAction(); hideAnnotationPreview();
  clearSelections();
  imageSelection = {imageId, imageName: imageNames.get(imageId) || 'Image', goalId: activeGoalId, version: activeVersion, rect: null};
  imageDrawing = null;
  imageAreaWhole.disabled = true;
  imageAreaDialog.querySelector('.image-area-hint').textContent = 'Drag to select. Drag again to redraw.';
  imageAreaImage.alt = imageSelection.imageName;
  imageAreaImage.src = `/api/images/${imageId}`;
  updateImageSelection();
  imageAreaDialog.showModal();
}
function closeImageSelection() {
  imageDrawing = null;
  imageSelection = null;
  if (imageAreaDialog.open) imageAreaDialog.close();
}
imageAreaImage.addEventListener('load', () => { imageAreaWhole.disabled = false; });
imageAreaImage.addEventListener('error', () => {
  imageAreaDialog.querySelector('.image-area-hint').textContent = 'Could not load image. Close and try again.';
});
imageAreaDialog.querySelector('[data-area-close]').addEventListener('click', closeImageSelection);
imageAreaDialog.addEventListener('cancel', event => { event.preventDefault(); closeImageSelection(); });
imageAreaWhole.addEventListener('click', () => {
  if (!imageSelection) return;
  imageSelection.rect = {x: 0, y: 0, width: 1, height: 1};
  updateImageSelection();
});
imageAreaNext.addEventListener('click', () => {
  if (!imageSelection?.rect || imageDrawing) return;
  const selection = imageSelection;
  closeImageSelection();
  if (selection.goalId !== activeGoalId || selection.version !== activeVersion) return;
  openNoteEditor({id: crypto.randomUUID(), kind: 'image', imageId: selection.imageId, imageName: selection.imageName, rect: selection.rect, text: ''});
});
function imagePoint(event) {
  const bounds = imageAreaImage.getBoundingClientRect();
  const unit = value => Math.max(0, Math.min(1, value));
  return {x: unit((event.clientX - bounds.left) / bounds.width), y: unit((event.clientY - bounds.top) / bounds.height)};
}
function moveImageSelection(event) {
  if (!imageDrawing || imageDrawing.pointerId !== event.pointerId || !imageSelection) return;
  const point = imagePoint(event), start = imageDrawing.start;
  imageSelection.rect = {x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y)};
  updateImageSelection();
}
imageAreaStage.addEventListener('pointerdown', event => {
  if (!imageSelection || imageDrawing || !event.isPrimary || event.button !== 0 || !imageAreaImage.complete || !imageAreaImage.naturalWidth) return;
  event.preventDefault();
  imageDrawing = {pointerId: event.pointerId, start: imagePoint(event), previous: imageSelection.rect};
  imageAreaStage.setPointerCapture(event.pointerId);
  moveImageSelection(event);
});
imageAreaStage.addEventListener('pointermove', moveImageSelection);
imageAreaStage.addEventListener('pointerup', event => {
  if (!imageDrawing || imageDrawing.pointerId !== event.pointerId || !imageSelection) return;
  moveImageSelection(event);
  const bounds = imageAreaImage.getBoundingClientRect(), area = imageSelection.rect;
  if (area.width * bounds.width < 8 || area.height * bounds.height < 8) imageSelection.rect = imageDrawing.previous;
  imageDrawing = null;
  updateImageSelection();
});
function cancelImageDrawing(event) {
  if (!imageDrawing || imageDrawing.pointerId !== event.pointerId || !imageSelection) return;
  imageSelection.rect = imageDrawing.previous;
  imageDrawing = null;
  updateImageSelection();
}
imageAreaStage.addEventListener('pointercancel', cancelImageDrawing);
imageAreaStage.addEventListener('lostpointercapture', cancelImageDrawing);

function imageIdFromSource(source) {
  try { return /^\/api\/images\/([0-9a-f-]{36})$/.exec(new URL(source, location.origin).pathname)?.[1] || null; }
  catch { return null; }
}
function noteEntries() {
  const saved = events.filter(event => event.goalId === activeGoalId).flatMap(event => [
    ...(event.annotations || []).map((note, index) => ({ref: `event-${event.id}-${index}`, note, event})),
  ]);
  const drafts=notesFor().filter(note=>!annotationOpen||note.id!==editingNote?.id).map(note=>({ref:`draft-${note.id}`,note,draft:true}));
  if(annotationOpen&&editingNote)drafts.push({ref:`draft-${editingNote.id}`,note:editingNote,draft:true,editing:true});
  return [...saved,...drafts];
}
function markText(body, anchor, ref, draft, editing) {
  const segments = [];
  let offset = 0;
  for (const node of annotationTextNodes(body)) {
    const end = offset + node.length;
    if (anchor.start < end && anchor.end > offset) segments.push({node, start: Math.max(0, anchor.start - offset), end: Math.min(node.length, anchor.end - offset)});
    offset = end;
  }
  for (const segment of segments.reverse()) {
    const {node, start, end} = segment;
    if (end < node.length) node.splitText(end);
    const selected = start ? node.splitText(start) : node;
    if (!selected.textContent.trim()) continue;
    const mark = document.createElement('span');
    mark.className = `annotation-mark ${draft ? 'is-draft' : ''}${editing ? ' is-editing' : ''}`;
    mark.dataset.noteRef = ref;
    if(!editing){
      mark.setAttribute('role', 'button');
      mark.tabIndex = 0;
      mark.setAttribute('aria-label', `${draft ? 'Edit' : 'View'} note: ${anchor.quote}`);
    }
    selected.replaceWith(mark);
    mark.append(selected);
  }
}
function renderAnnotations(openingEditor=false) {
  const body = briefRoot();
  if (!body) return;
  if (!openingEditor&&interactingWithAnnotation()) return;
  hideAnnotationPreview();
  annotationSources('.brief-body, [data-annotation-reply]').forEach(source => {
    source.querySelectorAll('.annotation-mark').forEach(mark => mark.replaceWith(...mark.childNodes));
    source.normalize();
  });
  annotationSources('.annotatable-image').forEach(wrapper => wrapper.replaceWith(wrapper.querySelector('img')));
  if (CSS.highlights) CSS.highlights.delete('note-annotations');
  visibleNotes.clear();
  const entries = noteEntries();
  entries.forEach(entry => visibleNotes.set(entry.ref, entry));
  for (const entry of entries.filter(item => item.note.kind === 'text').sort((a, b) => b.note.anchor.start - a.note.anchor.start)) {
    const targets = entry.note.source?.kind === 'comment'
      ? main.querySelectorAll(`[data-annotation-reply="${Number(entry.note.source.eventId)}"]`) : entry.note.source?.version===activeVersion?[body]:[];
    for (const target of targets) {
      if(entry.note.source.kind==='comment'&&(target.dataset.replyField||'text')!==(entry.note.source.field||'text'))continue;
      const base = Number(target.dataset.replyOffset || 0);
      markText(target, {...entry.note.anchor, start: entry.note.anchor.start - base, end: entry.note.anchor.end - base}, entry.ref, entry.draft, entry.editing);
    }
  }
  annotationSources('.brief-body img, .image-preview img, .event-image').forEach(img => {
    const imageId = imageIdFromSource(img.src);
    const attachment = Boolean(img.closest('.image-preview'));
    if (!imageId && !attachment) return;
    const matching = entries.filter(item => item.note.kind === 'image' && (imageId ? item.note.imageId === imageId : item.note.target === 'attachment'));
    const editable = imageId && img.closest('.brief-body');
    if (!matching.length && !editable) return;
    const wrapper = document.createElement('span');
    wrapper.className = 'annotatable-image';
    img.replaceWith(wrapper);
    wrapper.append(img);
    for (const entry of matching) {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = `image-note-box ${entry.draft ? 'is-draft' : ''}`;
      box.dataset.noteRef = entry.ref;
      box.setAttribute('aria-label', `${entry.draft ? 'Edit' : 'View'} image note: ${entry.note.text}`);
      positionArea(box, entry.note.rect);
      wrapper.append(box);
    }
    if (editable) {
      const annotate = document.createElement('button');
      annotate.type = 'button';
      annotate.className = 'image-annotate';
      annotate.dataset.action = 'annotate-image';
      annotate.dataset.imageId = imageId;
      annotate.setAttribute('aria-label', `Annotate image: ${imageNames.get(imageId) || 'Image'}`);
      annotate.title = 'Annotate image';
      annotate.innerHTML = icon('annotate');
      wrapper.append(annotate);
    }
  });
}

function openSavedPreview(entry, element) {
  const {note, event} = entry;
  annotationPreview.innerHTML = `<div class="annotation-heading"><strong>Note</strong><button type="button" class="text-button" data-note-action="close" aria-label="Close note">✕</button></div>
    <blockquote class="annotation-quote">${escapeHTML(noteSourceLabel(note) + noteLabel(note))}</blockquote><p class="event-text" lang="ja">${escapeHTML(note.text)}</p>${noteImageMarkup(note, true)}
    <button type="button" class="text-button" data-note-action="conversation" data-event-id="${event.id}">Conversation ↘</button>`;
  annotationPreview.hidden = false;
  const rect = viewportRect(element);
  annotationPreview.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - annotationPreview.offsetWidth - 6))}px`;
  const below = rect.bottom + 8;
  annotationPreview.style.top = `${below + annotationPreview.offsetHeight < window.innerHeight - 6 ? below : Math.max(6, rect.top - annotationPreview.offsetHeight - 8)}px`;
}

function openNoteReference(ref, scroll = false) {
  if(annotationOpen)return;
  const entry = visibleNotes.get(ref);
  if (!entry) return;
  if (entry.note.source?.kind === 'comment') revealConversationEvent(entry.note.source.eventId);
  else if (entry.note.kind === 'image') {
    const source=conversationFor(activeGoalId).find(e=>attachmentIdsFor(e).includes(entry.note.imageId));
    if(source)revealConversationEvent(source.id);
  }
  const target = (entry.note.kind==='letter'?document.getElementById(`event-${entry.note.source.eventId}`):null)
    || annotationSources(`.annotation-mark[data-note-ref="${ref}"], .image-note-box[data-note-ref="${ref}"]`)[0]
    || main.querySelector(`[data-note-ref="${ref}"]`);
  if (scroll && target) {
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    scrollInReadingPane(target);
  }
  if (entry.draft) openNoteEditor(entry.note);
  else if (target) {
    if (scroll) requestAnimationFrame(() => { if (target.isConnected) openSavedPreview(entry, target); });
    else openSavedPreview(entry, target);
  }
}

main.addEventListener('click', event => {
  const mark = event.target.closest('.annotation-mark, .image-note-box');
  if (mark) { event.preventDefault(); openNoteReference(mark.dataset.noteRef); return; }

});
main.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.annotation-mark')) {
    event.preventDefault(); event.target.click();
  }
});
annotationPreview.addEventListener('click', event => {
  const action = event.target.closest('[data-note-action]');
  if (!action) return;
  if (action.dataset.noteAction === 'conversation') {
    revealConversationEvent(Number(action.dataset.eventId));
    scrollInReadingPane(main.querySelector(`#event-${action.dataset.eventId}`));
  }
  hideAnnotationPreview();
});

function positionArea(element, area) {
  Object.assign(element.style, {left: `${area.x * 100}%`, top: `${area.y * 100}%`,
    width: `${area.width * 100}%`, height: `${area.height * 100}%`});
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAnnotation();
});
main.addEventListener('scroll', () => { hideAnnotationAction(); updateSelectionAction(); hideAnnotationPreview(); }, {passive: true});
window.addEventListener('resize', () => { hideAnnotationAction(); updateSelectionAction(); hideAnnotationPreview(); });

function updateBrandTarget(){
  const brand=document.querySelector('.brand'),target=goalView().brandTarget();
  brand.href=target.href;brand.setAttribute('aria-label',target.label);brand.title=target.label;
}
function renderIndex(){document.title='Goals · chill';main.innerHTML=goalView().index();}
let stepFocus=null;
function renderRoute() {
  hasNewBrief.dismiss();
  closeImageSelection();
  const beforeId=activeGoalId,top=main.scrollTop;
  annotationOpen=false;pendingAnchor=null;hideAnnotationAction();hideAnnotationPreview();removePendingImage('annotation');editingNote=null;
  // Keep the shared action alive before replacing an HTML frame that owns it.
  document.body.append(annotationAction);
  currentRoute=location.hash||'#/goals';
  const match=/^#\/goal\/([1-9][0-9]*)(?:\/v([1-9][0-9]*)|\/(?:letter|activity)\/([1-9][0-9]*))?$/.exec(currentRoute);
  activeGoalId=match&&goalMetadata.has(match[1])?match[1]:null;
  activeVersion=activeGoalId?Number(match[2]||latestVersion(activeGoalId)):null;
  if(activeGoalId&&(match[2]||activeVersion)&&!briefAt(activeGoalId,activeVersion))activeGoalId=null;
  agentMenu.routeChanged();
  extensionButtons.routeChanged();
  let ready=Promise.resolve();
  if(activeGoalId) {
    if(match?.[3])conversationWindow.reveal(activeGoalId,conversationFor(activeGoalId),Number(match[3]));
    ready=renderGoal(activeGoalId,activeVersion||0);
    main.querySelectorAll('.brief-detail[data-detail-id]').forEach(detail=>{detail.open=openDetails.has(`${activeGoalId}:v${activeVersion}:${detail.dataset.detailId}`);});
  } else if(currentRoute==='#/goals')renderIndex();
  else {main.innerHTML='<div class="not-found"><h1>Goal or Brief not found</h1><a href="#/goals">Back to Goals</a></div>';}
  main.scrollTop=beforeId===activeGoalId?top:0;
  activityControls.routeChanged();
  const deliveriesReady=refreshDeliveries().catch(()=>{});
  if(match?.[3]) {
    const routeFrame=main.firstElementChild;
    // HTML Briefs and diagrams can grow after the first render.
    Promise.all([ready,deliveriesReady]).then(()=>requestAnimationFrame(()=>{
      if(main.firstElementChild===routeFrame)scrollInReadingPane(document.getElementById(`event-${match[3]}`));
    }));
  }
  if(stepFocus) {const nav=main.querySelector('.version-pager');nav?.setAttribute('tabindex','-1');(nav?.querySelector(`[data-version-step="${stepFocus}"]`)||nav)?.focus({preventScroll:true});stepFocus=null;}
  updateBrandTarget();updateNoticeForRoute();
}
function updateNoticeForRoute() {
  const newer=hasNewBrief(activeGoalId,activeVersion,latestVersion(activeGoalId));
  pendingUpdateId=newer?activeGoalId:null;
  updateNotice.hidden=!newer;
  if(newer)updateNoticeText.textContent='Your brief has been updated';
  const historyLink=main.querySelector('.history-notice a');
  if(historyLink)historyLink.href=versionRoute(activeGoalId,latestVersion(activeGoalId));
}
main.addEventListener('click',event=>{
  stepFocus=event.target.closest('[data-version-step]')?.dataset.versionStep||null;
  const letters=event.target.closest('[data-letters]');
  if(letters){
    const view=goalView(),id=letters.dataset.letters,owners=view.descendants(id),paths=owners.filter(n=>n!==activeGoalId&&view.letterCount(n)>0);
    const closing=paths.length>0&&paths.every(n=>expandedGoals.has(n));
    paths.forEach(n=>closing?expandedGoals.delete(n):expandedGoals.add(n));refreshGoalFrame();
    main.querySelectorAll('.letter-row.pending').forEach(row=>{if(owners.includes(row.dataset.letterGoal))row.querySelector('.letter-card').classList.add('letter-highlight');});
    (main.querySelector(`[data-letters="${id}"]`)||main.querySelector(`[data-toggle="${id}"]`))?.focus({preventScroll:true});return;
  }
  const toggle=event.target.closest('[data-toggle]')||(!event.target.closest('a,button')&&event.target.closest('[data-row-toggle]'));
  if(toggle){const id=toggle.dataset.toggle||toggle.dataset.rowToggle;expandedGoals.has(id)?expandedGoals.delete(id):expandedGoals.add(id);refreshGoalFrame();main.querySelector(`[data-toggle="${id}"]`)?.focus({preventScroll:true});}
});

const openDeliveries = new Set();
main.addEventListener('toggle', event => {
  const detail = event.target;
  if (detail.open) void renderDiagrams(detail);
  if (detail.matches?.('.reply-detail')) {
    if (!detail.isConnected) return;
    if (detail.open) openReplies.add(detail.dataset.replyDetail); else openReplies.delete(detail.dataset.replyDetail);
    return;
  }
  if (detail.matches?.('.work-progress')) {
    if (!detail.isConnected) return;
    const view = workViews.get(detail.dataset.workId);
    if (view) view.open = detail.open;
    return;
  }
  if (detail.matches?.('.delivery-history')) {
    const id = Number(detail.dataset.deliveryId);
    if (detail.open) openDeliveries.add(id); else openDeliveries.delete(id);
    return;
  }
  if (!activeGoalId || !detail.matches?.('.brief-detail[data-detail-id]')) return;
  const key = `${activeGoalId}:v${activeVersion}:${detail.dataset.detailId}`;
  if (detail.open) openDetails.add(key);
  else openDetails.delete(key);
}, true);

main.addEventListener('input', event => {
  const input = event.target;
  if (input.dataset.input === 'annotation') {
    updateNoteEditorState();
  } else if (input.dataset.input === 'comment' && activeGoalId) {
    commentDrafts.set(formKey(activeGoalId, 'comment'), input.value);
    writeDraft('comment', activeGoalId, input.value);
    updateComposerState();
  }
});

main.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target.matches('textarea')) {
    event.preventDefault();
    const form=event.target.closest('form');
    const submitter=form?.dataset.form==='annotation'&&editingNote?.kind==='letter'?form.querySelector('button[value="comment"]'):undefined;
    form?.requestSubmit(submitter);
  }
});

main.addEventListener('change', event => {
  if (event.target.matches('[data-note-all], [data-note-toggle]')) {
    const checkbox = event.target;
    saveNotes(notesFor().map(note => checkbox.hasAttribute('data-note-all') || note.id === checkbox.dataset.noteToggle
      ? {...note, selected: checkbox.checked} : note));
    updateNotesPanel();
    return;
  }
  const input = event.target.closest('[data-image-type]');
  if (input?.files?.length) setPendingImages(input.dataset.imageType, [...input.files]);
});

main.addEventListener('paste', event => {
  if (!event.target.matches('textarea')) return;
  const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
  if (images.length) {
    event.preventDefault();
    setPendingImages(event.target.dataset.input === 'annotation' ? 'annotation' : 'comment', images);
  }
});

main.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || !activeGoalId) return;
  if (button.dataset.action === 'expand-conversation' || button.dataset.action === 'collapse-conversation') {
    if (annotationOpen || submitting.size) return;
    const messages=conversationFor(activeGoalId),side=button.dataset.side;
    const gap=button.closest('.conversation-gap'),edge=gap?.getBoundingClientRect()[side==='top'?'top':'bottom'];
    let added=[];
    if(gap)added=conversationWindow.expand(activeGoalId,messages,Number(button.dataset.firstId),Number(button.dataset.lastId),side);
    else conversationWindow.collapse(activeGoalId,messages);
    updateTimeline(activeGoalId);renderAnnotations();
    if(added.length) {
      const target=document.getElementById(`event-${added[0].id}`);
      // Start reading at the first revealed comment in either direction.
      if(target)main.scrollTop+=target.getBoundingClientRect().top-edge;
      const next=[...main.querySelectorAll('.conversation-gap')].find(item=>side==='top'
        ?Number(item.dataset.gapLast)===Number(button.dataset.lastId):Number(item.dataset.gapFirst)===Number(button.dataset.firstId));
      const focus=next?.querySelector(`[data-side="${side}"]`)||target?.querySelector('article');
      if(focus){if(focus.tagName==='ARTICLE')focus.tabIndex=-1;focus.focus({preventScroll:true});}
      announcement.textContent=`Showing ${added.length} ${side==='top'?'earlier':'later'} ${added.length===1?'comment':'comments'}.`;
    } else {
      scrollInReadingPane(main.querySelector('.conversation-heading h2'),'nearest');
      main.querySelector('.conversation-heading')?.setAttribute('tabindex','-1');
      main.querySelector('.conversation-heading')?.focus({preventScroll:true});
      announcement.textContent='Earlier comments collapsed.';
    }
    return;
  }
  const letterId=Number(button.dataset.letterId);
  if(button.dataset.action==='answer-letter') {
    const saved=notesFor().find(note=>note.kind==='letter'&&note.source.eventId===letterId);
    openNoteEditor(saved||{id:crypto.randomUUID(),kind:'letter',source:{kind:'comment',eventId:letterId},text:''});return;
  }
  if (button.dataset.action === 'locate-note') {
    event.preventDefault();
    const entry=visibleNotes.get(button.dataset.noteRef);
    if(entry?.note.source?.kind==='brief'&&entry.note.source.version!==activeVersion){location.hash=versionRoute(activeGoalId,entry.note.source.version);return;}
    openNoteReference(button.dataset.noteRef, true);
    return;
  }
  if (submitting.has(formKey(activeGoalId, 'comment'))) return;
  if (button.dataset.action === 'close-annotation') {
    closeAnnotation();
  } else if (button.dataset.action === 'edit-draft-note') {
    openNoteReference(`draft-${button.dataset.noteId}`, true);
  } else if (button.dataset.action === 'annotate-image') {
    openImageSelection(button.dataset.imageId);
  } else if (button.dataset.action === 'delete-draft-note') {
    if (annotationSaves.has(notesKey())) return;
    const noteId = button.dataset.noteId;
    const index = notesFor().findIndex(note => note.id === noteId);
    saveNotes(notesFor().filter(note => note.id !== noteId));
    if (editingNote?.id === noteId) closeAnnotation();
    renderAnnotations(); updateNotesPanel();
    const remaining = main.querySelectorAll('[data-action="delete-draft-note"]');
    (remaining[Math.min(index, remaining.length - 1)] || main.querySelector('#conversation-comment'))?.focus({ preventScroll: true });
    announcement.textContent = 'Note deleted.';
  } else if (button.dataset.action === 'delete-note' && editingNote) {
    saveNotes(notesFor().filter(note => note.id !== editingNote.id));
    closeAnnotation(); renderAnnotations(); updateNotesPanel();
    announcement.textContent = 'Note deleted.';
  } else if (button.dataset.action === 'remove-image') {
    removeImage(button.dataset.imageType, button.dataset.imageKey);
  }
});

async function saveFeedback(id, input) {
  const response = await fetch(`/api/goals/${id}/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save feedback.');
  if(activeGoalId===id){activityControls.saved(id,result.delivery);void activityControls.refresh();}
  return { ...result.feedback, at: new Date(result.feedback.updatedAt) };
}

function feedbackRequestId(id, kind, payload) {
  const key = JSON.stringify(payload);
  let previous;
  try { previous = JSON.parse(readDraft(`request-${kind}`, id)); } catch {}
  if (previous?.key === key && previous.id) return previous.id;
  const request = {id: crypto.randomUUID(), key};
  writeDraft(`request-${kind}`, id, JSON.stringify(request));
  return request.id;
}

function addEvent(item) {
  const index=events.findIndex(event=>event.id===item.id);
  if(index!==-1&&events[index].changeId>=item.changeId)return false;
  const event={...item,at:new Date(item.updatedAt)};
  if(index===-1)events.push(event);else events[index]=event;
  events.sort((a, b) => a.at - b.at || a.id - b.id);
  return true;
}

function showSaveError(form, error) {
  form.querySelector('.save-error')?.remove();
  const message = document.createElement('p');
  message.className = 'save-error';
  message.setAttribute('role', 'alert');
  message.textContent = error.message;
  form.append(message);
}

function notesPayload(notes, attachmentId) {
  return notes.map(note => {
    const attachment = attachmentIdsFor(note).length ? {attachmentIds: attachmentIdsFor(note)} : {};
    if (note.kind === 'letter') return {...attachment, kind: 'letter', source: note.source, text: note.text};
    if (note.kind === 'text') return {...attachment, kind: 'text', anchor: note.anchor, source: note.source, text: note.text};
    const imageId = note.target === 'attachment' ? attachmentId : note.imageId;
    if (!imageId) throw new Error('Attach the image before sending its notes.');
    return {...attachment, kind: 'image', imageId, ...(note.imageName ? {imageName: note.imageName} : {}), rect: note.rect, text: note.text};
  });
}

main.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.goalId;
  if (!activeGoalId || !briefsByGoal.has(id)) return;
  const version = Number(form.dataset.version);
  if (form.dataset.form === 'annotation') {
    const text = form.querySelector('textarea').value.trim();
    const files = imagesFor('annotation').map(image => image.file);
    if ((!text && !files.length && !attachmentIdsFor(editingNote).length) || !editingNote || annotationSaves.has(notesKey(id)) || imageReads.has(formKey(id, 'annotation')) || submitting.has(formKey(id, 'comment'))) return;
    const note = {...editingNote, text};
    const editor = editingNote;
    const sendNow=note.kind==='letter'&&event.submitter?.value==='comment';
    annotationSaves.add(notesKey(id));
    updateNoteEditorState(); updateComposerState();
    form.querySelector('.save-error')?.remove();
    try {
      const attachmentIds = [...attachmentIdsFor(note)];
      for (const file of files) attachmentIds.push(await uploadImage(file));
      note.attachmentIds = attachmentIds;
      delete note.attachmentId;
      const notes = notesFor(id).filter(item => item.id !== note.id);
      let entry;
      if(sendNow) {
        const payload={annotations:notesPayload([note])};
        entry=await saveFeedback(id,{...payload,requestId:feedbackRequestId(id,`annotation-${note.id}`,payload)});
        addEvent(entry);writeDraft(`request-annotation-${note.id}`,id,'');
      } else notes.push(note);
      saveNotes(notes, id);
      if (activeGoalId === id && form.isConnected) {
        if (editingNote === editor) closeAnnotation();
        renderAnnotations(); updateNotesPanel();
        if(sendNow) {
          updateTimeline(id);refreshGoalFrame();renderAnnotations();
          scrollInReadingPane(document.getElementById(`event-${entry.id}`),'nearest');
          announcement.textContent='Comment saved.';
        } else showToast('Added to your comment.');
      }
    } catch (error) {
      if (editingNote === editor) showSaveError(form, error);
    } finally {
      annotationSaves.delete(notesKey(id));
      if (activeGoalId === id && form.isConnected) { updateNoteEditorState(); updateComposerState(); }
    }
    return;
  }
  if (form.dataset.form !== 'comment') return;
  const key = formKey(id, 'comment');
  if (submitting.has(key) || annotationSaves.has(notesKey(id)) || imageReads.has(key)) return;
  const text=form.querySelector('textarea').value.trim();
  const files=imagesFor('comment').map(image=>image.file);
  const notes=structuredClone(selectedNotes());
  if(!text&&!files.length&&!notes.length){showSaveError(form,new Error('Write a comment or add an image or annotation.'));form.querySelector('textarea').focus();return;}
  form.querySelector('textarea').removeAttribute('aria-invalid');
  submitting.add(key);
  closeAnnotation();
  updateComposerState();
  form.querySelector('.save-error')?.remove();
  try {
    const attachmentIds = [];
    for (const file of files) attachmentIds.push(await uploadImage(file));
    const attachmentId = attachmentIds[0];
    const payload = {text, annotations: notesPayload(notes, attachmentId), ...(attachmentIds.length ? {attachmentIds} : {})};
    const entry = await saveFeedback(id, {requestId: feedbackRequestId(id, 'comment', payload), ...payload});
    addEvent(entry);
    writeDraft('request-comment', id, '');
    commentDrafts.delete(key);
    writeDraft('comment', id, '');
    const sent = new Set(notes.map(note => note.id));
    // Off notes survive, including notes on an image sent with this reply.
    saveNotes(notesFor(id).filter(note => !sent.has(note.id)).map(note => {
      if (note.target !== 'attachment' || !attachmentId) return note;
      const {target, ...saved} = note;
      return {...saved, imageId: attachmentId};
    }), id);
    removePendingImage('comment', id);
    if (activeGoalId !== id) return;
    const currentForm = main.querySelector('.conversation-form');
    currentForm.querySelector('textarea').value = '';
    updateNotesPanel();
    updateTimeline(id);
    refreshGoalFrame();
    renderAnnotations();
    scrollInReadingPane(document.getElementById(`event-${entry.id}`),'nearest');
    announcement.textContent = 'Comment saved.';
  } catch (error) {
    if (activeGoalId === id) showSaveError(main.querySelector('.conversation-form'), error);
  } finally {
    submitting.delete(key);
    if (activeGoalId === id) {updateComposerState();updateTimeline(id);renderAnnotations();}
  }
});

main.addEventListener('click', async event => {
  const continuation = event.target.closest('[data-action="view-work"]');
  if (continuation) {
    revealConversationEvent(Number(continuation.dataset.eventId));
    const target = document.getElementById(`delivery-${continuation.dataset.eventId}`);
    target?.querySelector('.work-progress > summary')?.focus({preventScroll: true});
    scrollInReadingPane(target);
    return;
  }
  const button = event.target.closest('[data-action="retry-delivery"]');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/goals/${button.dataset.goalId}/deliveries/${button.dataset.eventId}/retry`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check delivery.');
    await refreshDeliveries();
  } catch (error) { announcement.textContent = error.message; }
  finally { button.disabled = false; }
});

document.addEventListener('click', event => {
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    main.focus({preventScroll: true});
    return;
  }
  const link = event.target.closest('a[href^="#/"]');
  if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && link.hash === currentRoute) {
    event.preventDefault();
    const letter=/\/letter\/([1-9][0-9]*)$/.exec(currentRoute);
    if(letter){scrollInReadingPane(document.getElementById(`event-${letter[1]}`));return;}
    main.scrollTo({top: 0, behavior: 'auto'});
    main.querySelector('h1')?.focus({preventScroll: true});
  }
});
window.addEventListener('hashchange',async()=>{
  const target=location.hash;
  try {await loadStoredGoals();if(location.hash===target)renderRoute();}
  catch(error){announcement.textContent=error.message;}
});

// Only real interaction renews the server's idle timeout. The update polls below
// intentionally do not, so leaving a tab open cannot keep the server alive forever.
let lastInteractionSent = 0;
function reportInteraction(event) {
  if (!event.isTrusted || document.visibilityState !== 'visible' || Date.now() - lastInteractionSent < 60000) return;
  lastInteractionSent = Date.now();
  fetch('/api/activity', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})
    .catch(() => { lastInteractionSent = 0; });
}
for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove']) {
  document.addEventListener(type, reportInteraction, {capture: true, passive: true});
}

let storeSignature='';
async function loadStoredGoals() {
  const response=await fetch('/api/goals',{cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Could not load Goals. Your draft is kept.');
  const stored=await response.json(),signature=JSON.stringify(stored,(key,value)=>['checkedAt','expiresAt'].includes(key)?undefined:value),changed=signature!==storeSignature;
  storeSignature=signature;
  for(const {id,briefs,conversation,...metadata} of stored){goalMetadata.set(id,{id,...metadata});briefsByGoal.set(id,briefs);conversation.forEach(addEvent);}
  return changed;
}
async function updateCurrentBrief(version) {
  const id=activeGoalId,section=main.querySelector('.document-section');
  if(!section)return;
  const paneTop=main.getBoundingClientRect().top,conversation=main.querySelector('.conversation');
  const anchor=conversation?.getBoundingClientRect().top<main.getBoundingClientRect().bottom?conversation:null;
  const anchorTop=anchor?.getBoundingClientRect().top-paneTop,top=main.scrollTop,interaction=briefScrollInteraction;
  const brief=briefAt(id,version),isHTML=brief?.format==='html',height=section.offsetHeight;
  document.body.append(annotationAction);hideAnnotationAction();hideAnnotationPreview();pendingAnchor=null;
  // Only replace the Brief; keep the composer, active annotation editor and drafts.
  section.style.minHeight=`${height}px`;
  activeVersion=version;
  if(imageSelection?.goalId===id)imageSelection.version=version;
  if(/\/v[1-9][0-9]*$/.test(currentRoute)){
    currentRoute=versionRoute(id,version);history.replaceState(null,'',currentRoute);
  }
  section.innerHTML=`<div class="section-heading document-heading"><h2>Brief</h2>${goalView().pager(id,version)}</div><article class="surface document-card brief${isHTML?' html-brief':''}" aria-label="Brief"><div class="brief-body markdown-body" lang="ja" ${isHTML?'hidden':''}>${isHTML?'':briefBody(brief.html||'')}</div></article>`;
  imageNames.clear();
  section.querySelectorAll('img').forEach((img,index)=>{const imageId=imageIdFromSource(img.getAttribute('src'));if(imageId)imageNames.set(imageId,(img.title||img.alt||`Image ${index+1}`).slice(0,200));});
  main.querySelector('.annotation-form').dataset.version=String(version);
  renderAnnotations();
  await Promise.all([isHTML?mountHTMLBrief(id,version):Promise.resolve(),renderDiagrams(section)]);
  if(!section.isConnected||activeGoalId!==id||activeVersion!==version)return;
  section.style.minHeight='';
  if(interaction===briefScrollInteraction){
    if(anchor?.isConnected)main.scrollTop+=anchor.getBoundingClientRect().top-main.getBoundingClientRect().top-anchorTop;
    else main.scrollTop=top;
  }
}
async function refreshGoals(){
  const id=activeGoalId,previousLatest=latestVersion(id);
  if(!await loadStoredGoals())return;
  if(activeGoalId){
    updateNoticeForRoute();
    if(activeGoalId===id&&activeVersion===previousLatest&&latestVersion(id)>previousLatest)await updateCurrentBrief(latestVersion(id));
    refreshGoalFrame();updateTimeline(activeGoalId);renderAnnotations();updateNoticeForRoute();
    const heading=main.querySelector('.document-heading');
    if(heading&&!main.querySelector('.version-pager:focus-within'))heading.innerHTML=`<h2>Brief</h2>${briefAt(activeGoalId,activeVersion)?goalView().pager(activeGoalId,activeVersion):''}`;
  }else if(currentRoute==='#/goals')renderIndex();
}

async function refreshDeliveries() {
  const id = activeGoalId;
  if (!id) return;
  const response = await fetch(`/api/goals/${id}/deliveries`, {cache:'no-store'});
  if (!response.ok) return;
  const updates = await response.json();
  let changed = false;
  for (const update of updates) {
    if (JSON.stringify(deliveries.get(update.eventId)) !== JSON.stringify(update)) {
      deliveries.set(update.eventId, update); changed = true;
    }
  }
  if (changed && activeGoalId === id) {
    updateTimeline(id);
    renderAnnotations();
  }
}

function dismissBriefNotice(){hasNewBrief.dismiss();pendingUpdateId=null;updateNotice.hidden=true;}
let briefScrollInteraction=0;
function briefScrollIntent(event){
  if(event.type==='keydown'&&(!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)||event.target.closest('input,textarea,select,[contenteditable="true"]')))return;
  briefScrollInteraction++;dismissBriefNotice();
}
for(const type of ['wheel','touchmove','keydown'])main.addEventListener(type,briefScrollIntent,{passive:true});
main.addEventListener('pointerdown',event=>{if(event.target===main&&event.clientX>=main.getBoundingClientRect().left+main.clientWidth)briefScrollIntent(event);});
viewUpdate.addEventListener('click',()=>{
  if(!pendingUpdateId)return;
  briefScrollInteraction++;dismissBriefNotice();
  const heading=main.querySelector('.document-heading');
  if(heading){main.scrollTop+=heading.getBoundingClientRect().top-main.getBoundingClientRect().top-12;heading.querySelector('h2').setAttribute('tabindex','-1');heading.querySelector('h2').focus({preventScroll:true});}
});
loadStoredGoals().then(renderRoute,error=>{
 main.innerHTML=`<div class="not-found"><h1>Could not load Goals</h1><p>${escapeHTML(error.message)}</p></div>`;
}).finally(()=>{
 let refreshing=false;
 async function refresh(){
   // A lost Web connection must not leave an old Working spinner forever.
   let expired=false;
   for(const goal of goalMetadata.values())if(goal.execution?.status==='working'&&!(Date.parse(goal.execution.expiresAt)>Date.now())){
     goal.execution={...goal.execution,status:'unknown'};expired=true;
   }
   if(expired){storeSignature='';if(activeGoalId)refreshGoalFrame();else if(currentRoute==='#/goals')renderIndex();}
   if(refreshing)return;refreshing=true;
   try{await refreshGoals();await refreshDeliveries();if(timelineRefreshPending&&activeGoalId&&!interactingWithAnnotation()){updateTimeline(activeGoalId);renderAnnotations();}}
   catch(error){announcement.textContent=error.message;}finally{refreshing=false;}
 }
 setInterval(refresh,5000);
 // Controls must not wait behind loading the full conversation's execution logs.
 setInterval(()=>{if(document.visibilityState==='visible')void activityControls.refresh();},2000);
 document.addEventListener('visibilitychange',()=>{
   if(document.visibilityState==='visible'){void refresh();void activityControls.refresh();}
 });
});
