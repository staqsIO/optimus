/**
 * Optimus — Move Gemini/Meet transcripts to the shared ingestion folder.
 *
 * Each board member runs a copy of this in their own Google account so
 * meeting transcripts land in one place for the watcher to read.
 *
 * Install (per user, one-time):
 *   1. Open https://script.google.com → "New project"
 *   2. Paste this entire file as Code.gs
 *   3. Update SHARED_FOLDER_ID below if it ever changes
 *   4. Save (give the project a name like "Optimus Meet Sync")
 *   5. Run `syncTranscripts` once manually — Google will prompt for Drive
 *      authorization. Approve.
 *   6. Run `installTrigger` once. This schedules `syncTranscripts` every 15
 *      minutes thereafter.
 *
 * That's it. New Gemini transcripts dropped into your "Meet Recordings"
 * folder will be moved to the shared folder within ~15 minutes and ingested
 * by the Optimus watcher within another 5 minutes.
 *
 * Provenance: moveTo() reparents the file but preserves owner metadata.
 * The watcher reads `owners`/`lastModifyingUser` from the file in the
 * shared folder, so attribution survives the move automatically — no
 * custom properties or filename munging needed.
 */

const SHARED_FOLDER_ID = '1XnKoRxD4cvIqc1yBpMBVfRP3gVQXfQwn';
const SOURCE_FOLDER_NAME = 'Meet Recordings';

function syncTranscripts() {
  const sharedFolder = DriveApp.getFolderById(SHARED_FOLDER_ID);
  const sourceFolders = DriveApp.getFoldersByName(SOURCE_FOLDER_NAME);

  if (!sourceFolders.hasNext()) {
    console.log(`No "${SOURCE_FOLDER_NAME}" folder in your Drive — nothing to sync.`);
    return;
  }

  const sourceFolder = sourceFolders.next();
  const files = sourceFolder.getFiles();

  let moved = 0;
  let errors = 0;
  while (files.hasNext()) {
    const file = files.next();
    try {
      file.moveTo(sharedFolder);
      moved++;
      console.log(`Moved: ${file.getName()}`);
    } catch (err) {
      errors++;
      console.error(`Failed to move ${file.getName()}: ${err.message}`);
    }
  }

  console.log(`Done: moved ${moved}, errors ${errors}`);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'syncTranscripts') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncTranscripts')
    .timeBased()
    .everyMinutes(15)
    .create();
  console.log('Trigger installed: syncTranscripts runs every 15 minutes.');
}
