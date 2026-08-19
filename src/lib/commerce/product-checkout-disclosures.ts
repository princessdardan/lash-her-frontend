export type UsImportTerms = "DDU";

export interface ProductCheckoutDisclosureInput {
  cancellationPolicyAccepted?: boolean;
  cancellationPolicyVersion?: string;
  cancellationPolicyTextHash?: string;
  termsAccepted?: boolean;
  termsVersion?: string;
  termsTextHash?: string;
  usImportTerms?: UsImportTerms;
  usImportDisclosureVersion?: string;
  usImportDisclosureText?: string;
}
