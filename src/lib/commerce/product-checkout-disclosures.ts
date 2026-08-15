export type UsImportTerms = "DDU";

export interface ProductCheckoutDisclosureInput {
  cancellationPolicyAccepted?: boolean;
  cancellationPolicyVersion?: string;
  cancellationPolicyTextHash?: string;
  usImportTerms?: UsImportTerms;
  usImportDisclosureVersion?: string;
  usImportDisclosureText?: string;
}
