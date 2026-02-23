import { Router } from "express";
import { body, query } from "express-validator";
import { authenticate } from "../middlewares/auth";
import { createNote } from "../controllers/hubspotSyncController";
import { validate } from "../middlewares/validateRequest";
import {
  syncLead,
  checkProfile,
  getPropertyOptions,
  updateContact,
} from "../controllers/hubspotSyncController";

const router = Router();

import { getNotes, deleteNote } from "../controllers/hubspotSyncController";

router.get(
  "/notes",
  authenticate,
  [
    query("contactId").trim().notEmpty().withMessage("contactId is required"),
    validate,
  ],
  getNotes,
);

import { updateNote } from "../controllers/hubspotSyncController";

router.patch(
  "/notes/:noteId",
  authenticate,
  [
    body("notes").trim().notEmpty().withMessage("notes is required"),
    body("noteTitle").optional().trim().isLength({ max: 200 }),
    body("dealValue").optional().trim().isLength({ max: 100 }),
    body("nextStep").optional().trim().isLength({ max: 500 }),
    validate,
  ],
  updateNote,
);

router.delete("/notes/:noteId", authenticate, deleteNote);

router.post(
  "/create-note",
  authenticate,
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

router.post(
  "/sync-lead",
  authenticate,
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

router.get("/property-options", authenticate, getPropertyOptions);

router.patch(
  "/update-contact",
  authenticate,
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
