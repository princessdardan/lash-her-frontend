ALTER TABLE "shipping_package_profiles" DROP CONSTRAINT "shipping_package_profiles_capacity_check";--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "accepts_rigid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" DROP COLUMN "capacity_units";--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD CONSTRAINT "shipping_package_profiles_capacity_check" CHECK ("shipping_package_profiles"."max_weight_grams" > 0 AND "shipping_package_profiles"."tare_weight_grams" >= 0);