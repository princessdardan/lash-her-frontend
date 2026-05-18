import { test, expect } from '@playwright/test';
import { validateForm } from '../src/lib/form-validation';

test.describe('Contact Popup Validation', () => {
  const CONTACT_POPUP_VALIDATION = {
    email: [
      { type: 'required' as const, message: 'Email is required' },
      { type: 'email' as const, message: 'Please enter a valid email address' },
    ],
  };
  const CONTACT_POPUP_FULL_VALIDATION = {
    name: [{ type: 'required' as const, message: 'Name is required' }],
    ...CONTACT_POPUP_VALIDATION,
  };

  test('should fail when email is empty', () => {
    const { errors, isValid } = validateForm(
      { email: '' },
      CONTACT_POPUP_VALIDATION
    );
    expect(isValid).toBe(false);
    expect(errors.email).toBe('Email is required');
  });

  test('should fail when email is invalid', () => {
    const { errors, isValid } = validateForm(
      { email: 'invalid-email' },
      CONTACT_POPUP_VALIDATION
    );
    expect(isValid).toBe(false);
    expect(errors.email).toBe('Please enter a valid email address');
  });

  test('should fail when email contains HTML-special characters', () => {
    const { errors, isValid } = validateForm(
      { email: '"><img/src=x>@example.com' },
      CONTACT_POPUP_VALIDATION
    );

    expect(isValid).toBe(false);
    expect(errors.email).toBe('Please enter a valid email address');
  });

  test('should pass when email is valid', () => {
    const { errors, isValid } = validateForm(
      { email: 'test@example.com' },
      CONTACT_POPUP_VALIDATION
    );
    expect(isValid).toBe(true);
    expect(errors.email).toBeUndefined();
  });

  test('should require name for full contact variant', () => {
    const { errors, isValid } = validateForm(
      { name: '', email: 'test@example.com' },
      CONTACT_POPUP_FULL_VALIDATION
    );

    expect(isValid).toBe(false);
    expect(errors.name).toBe('Name is required');
  });

  test('should pass full contact validation when name and email are valid', () => {
    const { errors, isValid } = validateForm(
      { name: 'Test User', email: 'test@example.com' },
      CONTACT_POPUP_FULL_VALIDATION
    );

    expect(isValid).toBe(true);
    expect(errors.name).toBeUndefined();
    expect(errors.email).toBeUndefined();
  });
});
