// node:sqlite still emits an ExperimentalWarning. Hook stderr reaches the agent's
// transcript, where that line reads like a failure. Import this first from each
// command entry; every other warning keeps Node's usual output.
process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`);
});
