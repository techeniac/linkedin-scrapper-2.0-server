// One-time, explicitly user-requested cleanup: permanently deletes every row
// from the 4 tables backing the report dashboards' charts/tables —
// connection_requests, connection_request_events, message_activity,
// message_events — while leaving User/auth/HubSpot-related tables untouched.
//
// None of these 4 tables reference each other via foreign key (each only has
// a FK to User, with onDelete: Cascade FROM User TO these — not the reverse),
// so deleting them carries no ordering constraint and cannot cascade into
// anything else.
//
// Usage (run from backend/):
//   npx ts-node --transpile-only src/scripts/clearReportData.ts            # dry run — reports counts only
//   npx ts-node --transpile-only src/scripts/clearReportData.ts --apply    # actually deletes
import prisma from "../config/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const [connectionRequests, connectionRequestEvents, messageActivity, messageEvents] = await Promise.all([
    prisma.connectionRequest.count(),
    prisma.connectionRequestEvent.count(),
    prisma.messageActivity.count(),
    prisma.messageEvent.count(),
  ]);

  console.log("Current row counts:");
  console.log(`  connection_requests:       ${connectionRequests}`);
  console.log(`  connection_request_events: ${connectionRequestEvents}`);
  console.log(`  message_activity:          ${messageActivity}`);
  console.log(`  message_events:            ${messageEvents}`);

  if (!APPLY) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to permanently delete all of the above.");
    return;
  }

  console.log("\nDeleting...");
  const results = await prisma.$transaction([
    prisma.connectionRequest.deleteMany({}),
    prisma.connectionRequestEvent.deleteMany({}),
    prisma.messageActivity.deleteMany({}),
    prisma.messageEvent.deleteMany({}),
  ]);

  console.log("Deleted:");
  console.log(`  connection_requests:       ${results[0].count}`);
  console.log(`  connection_request_events: ${results[1].count}`);
  console.log(`  message_activity:          ${results[2].count}`);
  console.log(`  message_events:            ${results[3].count}`);
  console.log("\nDone. User/auth/HubSpot tables were not touched.");
}

main()
  .catch(e => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
