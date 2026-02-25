import { Router } from "express";
import { userAwareLimiter } from "../middlewares/rateLimiter";
import { body, query } from "express-validator";
import { authenticate } from "../middlewares/auth";
import {
  createNote,
  getNotes,
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
import {
  syncLead,
  checkProfile,
  getPropertyOptions,
  updateContact,
} from "../controllers/hubspotSyncController";

const router = Router();

router.get(
  "/tasks",
  authenticate,
  [
    query("contactId").trim().notEmpty().withMessage("contactId is required"),
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
    body("taskName").trim().notEmpty().withMessage("taskName is required"),
    body("priority")
      .isIn(["None", "Low", "Medium", "High"])
      .withMessage("priority must be None, Low, Medium, or High"),
    body("status").trim().notEmpty().withMessage("status is required"),
    body("dueDate").optional().isISO8601().withMessage("Invalid date format"),
    body("time")
      .optional()
      .matches(/^\d{2}:\d{2}$/)
      .withMessage("Invalid time format (HH:mm)"),
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
    body("taskName").trim().notEmpty().withMessage("taskName is required"),
    body("priority")
      .isIn(["None", "Low", "Medium", "High"])
      .withMessage("priority must be None, Low, Medium, or High"),
    body("status").trim().notEmpty().withMessage("status is required"),
    body("dueDate").optional().isISO8601().withMessage("Invalid date format"),
    body("time")
      .optional()
      .matches(/^\d{2}:\d{2}$/)
      .withMessage("Invalid time format (HH:mm)"),
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
router.delete("/tasks/:taskId", authenticate, deleteTask);

// GET /api/hubspot/notes - Get all notes for a contact
router.get(
  "/notes",
  authenticate,
  userAwareLimiter,
  [
    query("contactId").trim().notEmpty().withMessage("contactId is required"),
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
    body("notes").trim().notEmpty().withMessage("notes is required"),
    body("noteTitle").optional().trim().isLength({ max: 200 }),
    body("dealValue").optional().trim().isLength({ max: 100 }),
    body("nextStep").optional().trim().isLength({ max: 500 }),
    validate,
  ],
  updateNote,
);

// DELETE /api/hubspot/notes/:noteId - Delete a note
router.delete("/notes/:noteId", authenticate, deleteNote);

// POST /api/hubspot/create-note - Create a new note
router.post(
  "/create-note",
  authenticate,
  userAwareLimiter,
  [
    body("notes").trim().notEmpty().withMessage("notes is required"),
    body("contactId").trim().notEmpty().withMessage("contactId is required"),
    body("noteTitle").optional().trim().isLength({ max: 200 }),
    body("dealValue").optional().trim().isLength({ max: 100 }),
    body("nextStep").optional().trim().isLength({ max: 500 }),
    validate,
  ],
  createNote,
);

// GET /api/hubspot/check-profile - Check if LinkedIn profile exists in HubSpot
router.get(
  "/check-profile",
  authenticate,
  [
    query("username")
      .trim()
      .notEmpty()
      .withMessage("username is required")
      .isLength({ max: 100 })
      .withMessage("username too long"),
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
    body("contact").isObject().withMessage("contact object is required"),
    body("contact.name")
      .trim()
      .notEmpty()
      .withMessage("contact.name is required")
      .isLength({ max: 200 })
      .withMessage("name too long"),
    body("contact.profileUrl")
      .trim()
      .notEmpty()
      .withMessage("contact.profileUrl is required")
      .isURL()
      .withMessage("profileUrl must be valid URL"),
    body("contact.email")
      .optional({ values: "falsy" })
      .trim()
      .isEmail()
      .withMessage("Invalid email"),
    body("contact.phone")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("phone too long"),
    body("contact.website")
      .optional({ values: "falsy" })
      .trim()
      .isURL()
      .withMessage("Invalid website URL"),
    body("company")
      .isObject()
      .withMessage("company Associated with user profile is required"),
    body("company.name")
      .notEmpty()
      .withMessage("company name is required")
      .trim()
      .isLength({ max: 200 })
      .withMessage("company name too long"),
    body("company.companyUrl")
      .optional({ values: "falsy" })
      .trim()
      .isURL()
      .withMessage("Invalid company URL"),
    validate,
  ],
  syncLead,
);

// GET /api/hubspot/property-options - Get HubSpot property options
router.get("/property-options", authenticate, getPropertyOptions);

// PATCH /api/hubspot/update-contact - Update HubSpot contact
router.patch(
  "/update-contact",
  authenticate,
  userAwareLimiter,
  [
    query("username")
      .trim()
      .notEmpty()
      .withMessage("username is required")
      .isLength({ max: 100 })
      .withMessage("username too long"),
    body("email")
      .optional({ values: "falsy" })
      .trim()
      .isEmail()
      .withMessage("Invalid email"),
    body("phone")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("phone too long"),
    body("owner")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("owner ID too long"),
    body("lifecycle")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 50 })
      .withMessage("lifecycle too long"),
    body("company")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 200 })
      .withMessage("company too long"),
    validate,
  ],
  updateContact,
);

export default router;
