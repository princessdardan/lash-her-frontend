"""Finite staging learning/lifecycle admission; P1 remains unchanged."""
import json

FEATURE_CONTROLS = {
    "INTEGRATION_CUSTOMER_ACCESS_ENABLED": True, "INTEGRATION_COURSE_READS_ENABLED": True,
    "INTEGRATION_CHECKOUT_ENABLED": False, "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED": False,
    "INTEGRATION_COMMUNITY_READS_ENABLED": False, "INTEGRATION_COMMUNITY_WRITES_ENABLED": False,
    "INTEGRATION_LEARNING_ROUTES_ENABLED": True, "CUSTOMER_AUTH_ENABLED": True,
    "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED": True, "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED": True,
}
PROFILE = {"version": 1, "profile": "p2-learning-lifecycle", "featureControls": FEATURE_CONTROLS,
           "nativeSchedulesEnabled": False}
RUNTIME_FLAGS = {
    "course-api": {"COURSE_ACCOUNT_LIFECYCLE_ENABLED": "true"},
    "community-api": {"COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED": "true"},
    "course-media": {"MUX_MEDIA_RECOVERY_ENABLED": "true", "MUX_MEDIA_CLEANUP_ENABLED": "true"},
    "course-export-cleanup": {"COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED": "true"},
}


def require_profile(value):
    # Python bool/int equality is too permissive for this closed wire profile.
    if json.dumps(value, sort_keys=True) != json.dumps(PROFILE, sort_keys=True):
        raise ValueError("P2_CERTIFICATION_PROFILE_REFUSED")
    return value
