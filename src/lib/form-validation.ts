export interface ValidationRule {
  type: "required" | "email" | "phone" | "minLength" | "maxLength";
  message: string;
  value?: number;
}

export interface FieldValidationConfig {
  [fieldName: string]: ValidationRule[];
}

export type ValidationErrors = Record<string, string>;

/**
 * Validate a single field value against an array of rules.
 * Returns an error message string if invalid, or empty string if valid.
 */
export function validateField(
  value: string,
  rules: ValidationRule[]
): string {
  for (const rule of rules) {
    switch (rule.type) {
      case "required":
        if (!value || value.trim() === "") {
          return rule.message;
        }
        break;
      case "email": {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (value && !emailRegex.test(value)) {
          return rule.message;
        }
        break;
      }
      case "phone": {
        // Allow common formats: (123) 456-7890, 123-456-7890, +1 123 456 7890, etc.
        const phoneRegex = /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,4}[-\s.]?[0-9]{1,9}$/;
        if (value && !phoneRegex.test(value.replace(/\s/g, ""))) {
          return rule.message;
        }
        break;
      }
      case "minLength":
        if (rule.value !== undefined && value.length < rule.value) {
          return rule.message;
        }
        break;
      case "maxLength":
        if (rule.value !== undefined && value.length > rule.value) {
          return rule.message;
        }
        break;
      default: {
        // Exhaustive check
        const _never: never = rule.type;
        void _never;
      }
    }
  }
  return "";
}

/**
 * Validate all fields in a form against the given config.
 * Returns an errors map (field -> error message) and a boolean isValid.
 * Fields with no errors have an empty string in the map.
 */
export function validateForm(
  data: Record<string, string>,
  config: FieldValidationConfig
): { errors: ValidationErrors; isValid: boolean } {
  const errors: ValidationErrors = {};
  let isValid = true;

  for (const fieldName of Object.keys(config)) {
    const rules = config[fieldName];
    const value = data[fieldName] ?? "";
    const error = validateField(value, rules);
    if (error) {
      errors[fieldName] = error;
      isValid = false;
    }
  }

  return { errors, isValid };
}
