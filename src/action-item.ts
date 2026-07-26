import * as z from "zod";

export const FieldItemType = z.union(
  (
    [
      "text",
      "date",
      "integer",
      "digit_sequence",
      "multiple_choice",
      "calendar_slot",
      "cvv",
    ] as const
  ).map((val) => z.literal(val)),
);
export type FieldItemType = z.input<typeof FieldItemType>;

export type ChoiceGenerator = (query: string) => Promise<[string[], string[]]>;

export const FieldItem = z
  .object({
    item_type: z.literal("field"),
    key: z.string(),
    description: z.string().default(""),
    question: z.string().default(""),
    field_type: FieldItemType,
    required: z.boolean().default(true),
    choices: z.array(z.string()).default([]),
    choiceGenerator: z.custom<ChoiceGenerator>((val) => typeof val === "function").optional(),
    searchable: z.boolean().default(false),
    sensitive: z.boolean().default(false),
  })
  .superRefine((field, ctx) => {
    const hasChoices = field.choices.length > 0 || field.choiceGenerator !== undefined;
    if (
      hasChoices &&
      field.field_type !== "multiple_choice" &&
      field.field_type !== "calendar_slot"
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Field type ${field.field_type} does not support choices attribute.`,
      });
    }

    if (field.field_type === "multiple_choice" && field.choices.length > 10) {
      process.emitWarning(
        "Performance degrades with large number of choices for multiple choice field.",
        "ACTION_ITEM",
      );
    }
  });
export type FieldItem = z.input<typeof FieldItem>;

export const SerializableFieldItem = z.object({
  item_type: z.literal("field"),
  key: z.string(),
  description: z.string().default(""),
  question: z.string().default(""),
  field_type: FieldItemType,
  required: z.boolean().default(true),
  choices: z.array(z.string()).default([]),
  is_search_field: z.boolean().default(false),
  sensitive: z.boolean().default(false),
});
export type SerializableFieldItem = z.input<typeof SerializableFieldItem>;

export const SayItem = z.object({
  item_type: z.literal("say"),
  statement: z.string(),
  key: z.string().default(() => Math.random().toString(16).substring(2, 6)),
});
export type SayItem = z.input<typeof SayItem>;

export const TodoItem = z.object({
  item_type: z.literal("todo"),
  description: z.string(),
  key: z.string().default(() => Math.random().toString(16).substring(2, 6)),
});
export type TodoItem = z.input<typeof TodoItem>;

export const ActionItem = z.union([SerializableFieldItem, SayItem, TodoItem]);
export type ActionItem = z.input<typeof ActionItem>;

export function Field(options: {
  key: string;
  description?: string;
  question?: string;
  fieldType: FieldItemType;
  required?: boolean;
  choices?: string[];
  choiceGenerator?: ChoiceGenerator;
  searchable?: boolean;
  sensitive?: boolean;
}): FieldItem {
  return FieldItem.parse({
    item_type: "field",
    key: options.key,
    description: options.description,
    question: options.question,
    field_type: options.fieldType,
    required: options.required,
    choices: options.choices,
    choiceGenerator: options.choiceGenerator,
    searchable: options.searchable,
    sensitive: options.sensitive,
  });
}

export function Say(statement: string): SayItem {
  return SayItem.parse({
    item_type: "say",
    statement: statement,
  });
}
