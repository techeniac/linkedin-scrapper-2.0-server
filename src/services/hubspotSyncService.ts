// refactored: was ~1300-line monolith — now a facade that delegates to focused sub-services.
// Public API and constructor signature are unchanged; all callers continue to work without modification.
import { ContactData, CompanyData, SyncLeadResponse, CreateTaskRequest, UpdateTaskRequest, TaskResponse, LinkedInMessage, UpsertMessagesResponse } from "../types";
import { HubSpotContactService } from "./hubspotContactService";
import { HubSpotCompanyService } from "./hubspotCompanyService";
import { HubSpotNoteService } from "./hubspotNoteService";
import { HubSpotTaskService } from "./hubspotTaskService";
import { HubSpotMessageService } from "./hubspotMessageService";

export class HubSpotSyncService {
  private contactService: HubSpotContactService;
  private companyService: HubSpotCompanyService;
  private noteService: HubSpotNoteService;
  private taskService: HubSpotTaskService;
  private messageService: HubSpotMessageService;

  constructor(accessToken: string) {
    const baseUrl = "https://api.hubapi.com";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    this.contactService = new HubSpotContactService(baseUrl, headers);
    this.companyService = new HubSpotCompanyService(baseUrl, headers);
    this.noteService = new HubSpotNoteService(baseUrl, headers);
    this.taskService = new HubSpotTaskService(baseUrl, headers);
    this.messageService = new HubSpotMessageService(baseUrl, headers);
  }

  // --- Contact ---
  syncFullLead(contact: ContactData, company: CompanyData | null, ownerId?: string): Promise<SyncLeadResponse> {
    return this.contactService.syncFullLead(contact, company, ownerId);
  }

  upsertContact(contact: ContactData, ownerId?: string) {
    return this.contactService.upsertContact(contact, ownerId);
  }

  findContactByProfileUrl(username: string) {
    return this.contactService.findContactByProfileUrl(username);
  }

  updateContactByUsername(username: string, updates: Parameters<HubSpotContactService["updateContactByUsername"]>[1]) {
    return this.contactService.updateContactByUsername(username, updates);
  }

  getPropertyOptions() {
    return this.contactService.getPropertyOptions();
  }

  // --- Company ---
  upsertCompany(company: CompanyData, ownerId?: string) {
    return this.companyService.upsertCompany(company, ownerId);
  }

  // --- Notes ---
  createNote(data: Parameters<HubSpotNoteService["createNote"]>[0]) {
    return this.noteService.createNote(data);
  }

  getNotesByContact(contactId: string) {
    return this.noteService.getNotesByContact(contactId);
  }

  updateNote(noteId: string, data: Parameters<HubSpotNoteService["updateNote"]>[1]) {
    return this.noteService.updateNote(noteId, data);
  }

  deleteNote(noteId: string) {
    return this.noteService.deleteNote(noteId);
  }

  // --- Tasks ---
  getTasksByContact(contactId: string): Promise<TaskResponse[]> {
    return this.taskService.getTasksByContact(contactId);
  }

  createTask(data: CreateTaskRequest, ownerId?: string): Promise<TaskResponse> {
    return this.taskService.createTask(data, ownerId);
  }

  updateTask(taskId: string, data: UpdateTaskRequest): Promise<TaskResponse> {
    return this.taskService.updateTask(taskId, data);
  }

  deleteTask(taskId: string): Promise<void> {
    return this.taskService.deleteTask(taskId);
  }

  // --- Messages ---
  upsertLinkedInMessages(conversationKey: string, messages: LinkedInMessage[], ownerId?: string): Promise<UpsertMessagesResponse> {
    return this.messageService.upsertLinkedInMessages(conversationKey, messages, ownerId);
  }
}
