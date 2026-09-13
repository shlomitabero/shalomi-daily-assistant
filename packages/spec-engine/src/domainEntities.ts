import type { Entity } from "@forge/shared";

/**
 * Keyword-triggered library of common business entities. This is the corpus
 * the heuristic (offline, no-LLM) provider matches against. Real accuracy
 * comes from the Anthropic provider; this exists so Forge AI works with zero
 * configuration and produces deterministic, testable output.
 */
export interface DomainEntityRule {
  keywords: string[];
  entity: Entity;
}

export const DOMAIN_ENTITY_RULES: DomainEntityRule[] = [
  {
    keywords: ["customer", "client", "lead"],
    entity: {
      name: "Customer",
      description: "A person or company the business serves.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        },
        { name: "source", type: "text", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["appointment", "booking", "reservation", "schedule"],
    entity: {
      name: "Appointment",
      description: "A scheduled time slot with a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "date", type: "date", required: true },
        { name: "service", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Scheduled", "Completed", "Cancelled", "No-show"],
        },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["employee", "staff", "team member", "worker"],
    entity: {
      name: "Employee",
      description: "A person who works for the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "role", type: "text", required: false },
        { name: "email", type: "text", required: false },
        { name: "active", type: "boolean", required: false },
      ],
    },
  },
  {
    keywords: ["invoice", "billing", "payment"],
    entity: {
      name: "Invoice",
      description: "A bill issued to a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Draft", "Sent", "Paid", "Overdue"],
        },
        { name: "dueDate", type: "date", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["order", "purchase", "checkout"],
    entity: {
      name: "Order",
      description: "A purchase placed by a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "total", type: "number", required: true },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Pending", "Shipped", "Delivered", "Cancelled"],
        },
        { name: "items", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["service", "treatment"],
    entity: {
      name: "Service",
      description: "Something the business offers for sale.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "price", type: "number", required: false },
        { name: "durationMinutes", type: "number", required: false },
        { name: "description", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["product", "inventory", "stock"],
    entity: {
      name: "Product",
      description: "An item the business sells or tracks.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "sku", type: "text", required: false },
        { name: "price", type: "number", required: false },
        { name: "quantity", type: "number", required: false },
      ],
    },
  },
  {
    keywords: ["deal", "negotiation", "pipeline"],
    entity: {
      name: "Deal",
      description: "A potential sale being pursued.",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "value", type: "number", required: false },
        {
          name: "stage",
          type: "enum",
          required: true,
          enumValues: ["Lead", "Negotiation", "Won", "Lost"],
        },
        { name: "owner", type: "text", required: false },
      ],
    },
  },
];

export const ROLE_KEYWORDS: Record<string, string[]> = {
  Admin: ["admin", "administrator", "owner"],
  Manager: ["manager", "management"],
  Employee: ["employee", "staff", "worker", "team member"],
  Customer: ["customer portal", "client portal", "self-service"],
};

export const DEFAULT_ENTITY: Entity = {
  name: "Item",
  description: "A generic record. Refine this by naming real entities in your description.",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "description", type: "longtext", required: false },
    {
      name: "status",
      type: "enum",
      required: true,
      enumValues: ["Active", "Inactive"],
    },
  ],
};
