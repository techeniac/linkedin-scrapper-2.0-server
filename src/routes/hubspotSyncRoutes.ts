import { Router } from "express";
import { body, query } from "express-validator";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validateRequest";
import {
  syncLead,
  checkProfile,
  getPropertyOptions,
  updateContact,
} from "../controllers/hubspotSyncController";

const router = Router();

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
    body("company").optional().isObject(),
    body("company.name")
      .optional({ values: "falsy" })
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
    body("name")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage("name must be 1-200 characters"),
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
