import { Router } from "express";
import { userAwareLimiter } from "../middlewares/rateLimiter";
import { body, query, param } from "express-validator";
import { authenticate } from "../middlewares/auth";
import { upsertMessages } from "../controllers/hubspotSyncController";
import {
  createNote,
  getNotes,
  getAllNotesByOwner,
  deleteNote,
  updateNote,
} from "../controllers/hubspotSyncController";
import { validate } from "../middlewares/validateRequest";
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
} from "../controllers/taskController";
import { getAllTasksByOwner } from "../controllers/hubspotSyncController";
import {
  syncLead,
  checkProfile,
  getPropertyOptions,
  updateContact,
  getContactsByOwner,
  getAllContacts,
} from "../controllers/hubspotSyncController";

const router = Router();

// GET /api/hubspot/tasks/all — all tasks for current owner's contacts
router.get("/tasks/all", authenticate, userAwareLimiter, getAllTasksByOwner);

// GET /api/hubspot/tasks - Get all tasks for a contact
router.get(
  "/tasks",
  authenticate,
  userAwareLimiter,
  [
    query("contactId").trim().notEmpty().withMessage("No contact was selected"),
    validate,
  ],
  getTasks,
);

// POST /api/hubspot/create-task - Create a new task
router.post(
  "/create-task",
  authenticate,
  userAwareLimiter,
  [
    body("taskName").trim().notEmpty().withMessage("Task name is required"),
    body("priority")
      .isIn(["None", "Low", "Medium", "High"])
      .withMessage("Priority must be None, Low, Medium, or High"),
    body("status").trim().notEmpty().withMessage("Task status is required"),
    body("dueDate").optional().isISO8601().withMessage("Please enter a valid due date"),
    body("time")
      .optional()
      .matches(/^\d{2}:\d{2}$/)
      .withMessage("Please enter a valid time"),
    body("assignedTo").optional().trim(),
    body("comment").optional().trim(),
    body("contactId").optional().trim(),
    validate,
  ],
  createTask,
);

// PATCH /api/hubspot/tasks/:taskId - Update a task
router.patch(
  "/tasks/:taskId",
  authenticate,
  userAwareLimiter,
  [
    param("taskId").matches(/^\d+$/).withMessage("That task could not be found"),
    body("taskName").trim().notEmpty().withMessage("Task name is required"),
    body("priority")
      .isIn(["None", "Low", "Medium", "High"])
      .withMessage("Priority must be None, Low, Medium, or High"),
    body("status").trim().notEmpty().withMessage("Task status is required"),
    body("dueDate").optional().isISO8601().withMessage("Please enter a valid due date"),
    body("time")
      .optional()
      .matches(/^\d{2}:\d{2}$/)
      .withMessage("Please enter a valid time"),
    body("assignedTo")
      .notEmpty()
      .trim()
      .withMessage("Please assign this task to someone"),
    body("comment").optional().trim(),
    validate,
  ],
  updateTask,
);

// DELETE /api/hubspot/tasks/:taskId - Delete a task
router.delete(
  "/tasks/:taskId",
  authenticate,
  userAwareLimiter,
  [param("taskId").matches(/^\d+$/).withMessage("That task could not be found"), validate],
  deleteTask,
);

// GET /api/hubspot/notes/all - Get all notes for the authenticated user's contacts
router.get("/notes/all", authenticate, userAwareLimiter, getAllNotesByOwner);

// GET /api/hubspot/notes - Get paginated notes for a contact
router.get(
  "/notes",
  authenticate,
  userAwareLimiter,
  [
    query("contactId").trim().notEmpty().withMessage("No contact was selected"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("Limit must be between 1 and 50"),
    query("after").optional().trim(),
    validate,
  ],
  getNotes,
);

// PATCH /api/hubspot/notes/:noteId - Update a note
router.patch(
  "/notes/:noteId",
  authenticate,
  userAwareLimiter,
  [
    param("noteId").matches(/^\d+$/).withMessage("That note could not be found"),
    body("notes").trim().notEmpty().withMessage("Note text is required"),
    body("noteTitle").optional().trim().isLength({ max: 200 }).withMessage("Note title is too long"),
    body("dealValue").optional().trim().isLength({ max: 100 }).withMessage("Deal value is too long"),
    body("nextStep").optional().trim().isLength({ max: 500 }).withMessage("Next step is too long"),
    validate,
  ],
  updateNote,
);

// DELETE /api/hubspot/notes/:noteId - Delete a note
router.delete(
  "/notes/:noteId",
  authenticate,
  userAwareLimiter,
  [param("noteId").matches(/^\d+$/).withMessage("That note could not be found"), validate],
  deleteNote,
);

// POST /api/hubspot/create-note - Create a new note
router.post(
  "/create-note",
  authenticate,
  userAwareLimiter,
  [
    body("notes").trim().notEmpty().withMessage("Note text is required"),
    body("contactId").trim().notEmpty().withMessage("No contact was selected"),
    body("noteTitle").optional().trim().isLength({ max: 200 }).withMessage("Note title is too long"),
    body("dealValue").optional().trim().isLength({ max: 100 }).withMessage("Deal value is too long"),
    body("nextStep").optional().trim().isLength({ max: 500 }).withMessage("Next step is too long"),
    validate,
  ],
  createNote,
);

// GET /api/hubspot/check-profile - Check if LinkedIn profile exists in HubSpot
router.get(
  "/check-profile",
  authenticate,
  userAwareLimiter,
  [
    query("username")
      .trim()
      .notEmpty()
      .withMessage("No LinkedIn profile was found on this page")
      .isLength({ max: 100 })
      .withMessage("This LinkedIn profile link looks too long to be valid")
      .matches(/^[a-zA-Z0-9\-_%]+$/)
      .withMessage("This LinkedIn profile link contains characters we don't recognize"),
    validate,
  ],
  checkProfile,
);

// POST /api/hubspot/sync-lead - Sync LinkedIn lead to HubSpot
router.post(
  "/sync-lead",
  authenticate,
  userAwareLimiter,
  [
    body("contact").isObject().withMessage("Contact details are required"),
    body("contact.name")
      .trim()
      .notEmpty()
      .withMessage("Contact name is required")
      .isLength({ max: 200 })
      .withMessage("Contact name is too long"),
    body("contact.profileUrl")
      .trim()
      .notEmpty()
      .withMessage("This profile's LinkedIn URL is required")
      .isURL()
      .withMessage("This profile's LinkedIn URL doesn't look valid"),
    body("contact.email")
      .optional({ values: "falsy" })
      .trim()
      .isEmail()
      .withMessage("Please enter a valid email address"),
    body("contact.phone")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("Phone number is too long"),
    body("contact.website")
      .optional({ values: "falsy" })
      .trim()
      .isURL()
      .withMessage("Please enter a valid website URL"),
    // Optional: a profile's current position may have no linkable LinkedIn
    // company page (private/unlisted company, or no current position at
    // all) — the extension intentionally still syncs the contact on its own
    // in that case (ProfileCard.tsx) rather than blocking the whole sync,
    // sending an empty-fields company placeholder. syncLead normalizes that
    // down to no company at all; this validation only needs to check shape
    // when a REAL company name is actually present.
    body("company").optional().isObject().withMessage("Company details must be an object"),
    body("company.name")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 200 })
      .withMessage("Company name is too long"),
    body("company.companyUrl")
      .optional({ values: "falsy" })
      .trim()
      .isURL()
      .withMessage("Please enter a valid company URL"),
    body("contact.headline").optional().trim().isLength({ max: 500 }).withMessage("Headline is too long"),
    body("contact.selectedRole").optional().trim().isLength({ max: 200 }).withMessage("Job title is too long"),
    body("contact.selectedCompany").optional().trim().isLength({ max: 200 }).withMessage("Company name is too long"),
    body("contact.connectedOn").optional().trim().isLength({ max: 100 }).withMessage("Connected-on date is too long"),
    body("contact.experiences").optional().isArray({ max: 50 }).withMessage("This profile has too many work experiences to sync"),
    body("contact.experiences.*.role").optional().trim().isLength({ max: 200 }).withMessage("A work experience's job title is too long"),
    body("contact.experiences.*.companyLine").optional().trim().isLength({ max: 200 }).withMessage("A work experience's company name is too long"),
    body("contact.experiences.*.dates").optional().trim().isLength({ max: 100 }).withMessage("A work experience's dates are too long"),
    validate,
  ],
  syncLead,
);

// GET /api/hubspot/contacts/all - Get all contacts (cached, for client-side search)
router.get("/contacts/all", authenticate, userAwareLimiter, getAllContacts);

// GET /api/hubspot/contacts - Get all contacts owned by the authenticated user
// Query params: page, limit, search, sortBy, sortOrder
router.get(
  "/contacts",
  authenticate,
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page number must be a positive number"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 200 })
      .withMessage("Limit must be between 1 and 200"),
    query("search")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Search text is too long"),
    query("sortBy")
      .optional()
      .isIn(["firstname", "lastname", "email", "createdate", "lastmodifieddate"])
      .withMessage("Sort field must be one of: first name, last name, email, created date, last modified date"),
    query("sortOrder")
      .optional()
      .isIn(["ascending", "descending", "ASCENDING", "DESCENDING"])
      .withMessage("Sort order must be ascending or descending"),
    validate,
  ],
  getContactsByOwner,
);

// GET /api/hubspot/property-options - Get HubSpot property options
router.get(
  "/property-options",
  authenticate,
  userAwareLimiter,
  getPropertyOptions,
);

// PATCH /api/hubspot/update-contact - Update HubSpot contact
router.patch(
  "/update-contact",
  authenticate,
  userAwareLimiter,
  [
    query("username")
      .trim()
      .notEmpty()
      .withMessage("No LinkedIn profile was found on this page")
      .isLength({ max: 100 })
      .withMessage("This LinkedIn profile link looks too long to be valid")
      .matches(/^[a-zA-Z0-9\-_%]+$/)
      .withMessage("This LinkedIn profile link contains characters we don't recognize"),
    body("email")
      .optional({ values: "falsy" })
      .trim()
      .isEmail()
      .withMessage("Please enter a valid email address"),
    body("phone")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("Phone number is too long"),
    body("owner")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("Owner selection is invalid"),
    body("lifecycle")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("Lifecycle stage is invalid"),
    body("company")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 200 })
      .withMessage("Company name is too long"),
    validate,
  ],
  updateContact,
);

// POST /api/hubspot/upsert-messages - Upsert LinkedIn messages
router.post(
  "/upsert-messages",
  authenticate,
  userAwareLimiter,
  [
    body("conversationKey")
      .trim()
      .notEmpty()
      .withMessage("Couldn't identify this LinkedIn conversation"),
    body("messages")
      .isArray({ min: 1, max: 500 })
      .withMessage("No messages to sync, or too many at once (max 500)"),
    body("messages.*.text")
      .trim()
      .notEmpty()
      .withMessage("A message with no text can't be synced"),
    body("messages.*.sentAt")
      .trim()
      .notEmpty()
      .isISO8601()
      .withMessage("A message has an invalid timestamp"),
    body("messages.*.sender.name")
      .trim()
      .notEmpty()
      .withMessage("A message is missing the sender's name"),
    body("messages.*.sender.profileUrl")
      .trim()
      .notEmpty()
      .isURL()
      .withMessage("A message has an invalid sender LinkedIn URL"),
    body("messages.*.sender.distance")
      .trim()
      .notEmpty()
      .withMessage("A message is missing the sender's connection info"),
    body("messages.*.receiver.name")
      .trim()
      .notEmpty()
      .withMessage("A message is missing the recipient's name"),
    body("messages.*.receiver.profileUrl")
      .trim()
      .notEmpty()
      .isURL()
      .withMessage("A message has an invalid recipient LinkedIn URL"),
    body("messages.*.receiver.distance")
      .trim()
      .notEmpty()
      .withMessage("A message is missing the recipient's connection info"),
    validate,
  ],
  upsertMessages,
);

export default router;
