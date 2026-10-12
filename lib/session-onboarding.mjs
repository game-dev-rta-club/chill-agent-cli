// Shared first-use experience. Native activation stays in the selected adapter.
export const onboarding = {
 order: [
  'Use the prepared workspace and the selected activation/createRoot confirmation rules. Reuse a Goal already owned by this conversation; never take another conversation\'s Goal or create a duplicate on resume.',
  'On first use, create one initial Goal and publish its Brief before asking the user for an outcome. If an outcome was supplied, use it immediately. Otherwise use initialGoal below in the user\'s language; this authorizes discovery, not implementation.',
  'Open the saved Goal URL with the host browser/open tool now, before ending the turn or asking the user to act. If native activation prevents creation, open the returned workspace URL now and explain that single remaining step. Do not leave Web unopened while waiting for approval.',
  'Use the short messages below in the user\'s language, filling only verified facts and URLs. Ask the missing outcome in a Letter on the initial Goal so the user can answer from Web. If no Goal can yet be created, ask in the current chat. Never require the user to describe an outcome they already supplied.',
  'As the user answers, update this same Goal\'s title, scope, criteria and Brief. Keep the discussion and URL. A separate onboarding Goal must not be left behind.'
 ],
 initialGoal: {
  title: "Let's decide what you want to achieve",
  scope: 'Discuss the desired outcome and agree what to entrust. Implementation has not yet been requested.',
  criteria: 'The desired outcome, the first scope of work and how to recognize success are clear.',
  brief: "# Let's decide what you want to achieve\n\nTell me what you would like to do or what is troubling you. It does not need to be fully decided yet.\n\nWe will turn this page into your first Goal together, updating its title and plan as we talk. No implementation work has started."
 },
 messages: {
  installMissingTool: '{tool} is needed to {purpose}, and is not ready on this computer. May I {specificInstallation}? {localOnlyOption}',
  opened: "I've opened [your Goal]({url}). We will keep the plan and progress on this page.",
  browserUnavailable: 'I could not open the page automatically. Open [your Goal]({url}) to continue.',
  outcomeMissing: 'What would you like to achieve, or what is troubling you? A rough idea is enough.',
  outcomeProvided: 'I have put {outcome} on [your Goal]({url}). {nextAgreedAction}',
  activationPending: 'The Web page is ready: [open it here]({url}). Connecting its replies to this conversation still needs {action}. {reason}',
  connected: 'Replies from this Goal are addressed to this conversation. You can continue on [the Goal page]({url}).'
 },
 reporting: 'Say opened only after the browser tool succeeds. A running Web or installed Hook is not a verified reply route. Explain an observed blocker and one concrete action; use the adapter activation guidance instead of copying raw setup output. If the native control is unknown, inspect it or say what is unverified; never invent a menu path. Keep runtime paths and diagnostic prose out of the normal welcome. Include any permission explanation required by the host separately.'
};
