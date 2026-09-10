app_hostname      = "one-door.sandbox.truss.coffee"
route53_zone_name = "sandbox.truss.coffee"
route53_zone_id   = "ZF5E6T2ONJR1H"

alarm_actions_enabled = true
alert_email           = "maz@truss.works"
budget_limit_usd      = "100"
budget_warning_usd    = "75"

# The account team owns the regional detector and the organization trail.
create_guardduty_detector = false
include_management_events = false

# The shared sandbox's other applications must not count toward this budget.
# Billing-tag activation is checked separately in the management account;
# until confirmed, the filtered spending alerts remain unverified.
budget_cost_tag = "Application"
