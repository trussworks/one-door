variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "github_subject" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "allow_legacy_viewer_tls" {
  type    = bool
  default = false
}

variable "alarm_actions_enabled" {
  type = bool
}
variable "create_guardduty_detector" {
  type        = bool
  default     = true
  description = "Set false when the account team already owns the regional GuardDuty detector."
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "app_hostname" {
  type        = string
  default     = ""
  description = "Canonical public hostname. Empty keeps the CloudFront-generated name and its TLS 1.0 minimum, which only the personal rehearsal may use."
  validation {
    # A trailing dot, an upper-case letter or a scheme reaches ACM and CloudFront
    # as a different name than the browser sends, and the mismatch only shows up
    # once the certificate is already waiting on validation.
    condition     = var.app_hostname == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.app_hostname))
    error_message = "app_hostname must be a plain lower-case DNS name with at least two labels: no scheme, port, path, trailing dot or upper-case letter."
  }
  validation {
    condition     = length(var.app_hostname) <= 253
    error_message = "app_hostname must be 253 characters or fewer."
  }
}

variable "route53_zone_name" {
  type        = string
  default     = ""
  description = "Name of the approved public hosted zone that will hold the records. The lookup selects a public zone by this name, so a private zone can never be chosen."
  validation {
    condition     = var.route53_zone_name == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.route53_zone_name))
    error_message = "route53_zone_name must be a plain lower-case DNS name with no trailing dot."
  }
}

variable "route53_zone_id" {
  type        = string
  default     = ""
  description = "Id of the approved zone. The name selects a public zone and this id approves the one selected, so a different zone with the same name fails planning."
  validation {
    # Without the pairing check a hostname supplied alone is silently ignored,
    # leaving the generated CloudFront name in every origin.
    condition     = (var.app_hostname == "") == (var.route53_zone_id == "") && (var.app_hostname == "") == (var.route53_zone_name == "")
    error_message = "app_hostname, route53_zone_name and route53_zone_id belong together: a hostname needs the zone that will hold its validation and alias records, named and approved by id."
  }
}

variable "include_management_events" {
  type        = bool
  default     = true
  description = "Set false where an organization trail already records management events; duplicate delivery is charged again and adds no coverage."
}

variable "budget_limit_usd" {
  type        = string
  default     = null
  description = "Budget limit in US dollars. A budget notifies; it does not cap spending. Required outside the personal rehearsal, which keeps its approved 65."
  validation {
    condition     = var.environment == "personal" || var.budget_limit_usd != null
    error_message = "A client account needs its own approved budget limit; the personal figure is not a default anyone agreed to."
  }
  validation {
    condition     = var.budget_limit_usd == null || (can(tonumber(var.budget_limit_usd)) && tonumber(var.budget_limit_usd) > 0)
    error_message = "budget_limit_usd must be a positive number of dollars."
  }
}

variable "budget_warning_usd" {
  type        = string
  default     = null
  description = "Spend that triggers the first notice, below budget_limit_usd. Required outside the personal rehearsal, which keeps its approved 50."
  validation {
    condition     = var.environment == "personal" || var.budget_warning_usd != null
    error_message = "A client account needs its own early notice; a budget whose only signal is the limit gives no warning."
  }
  validation {
    condition     = var.budget_warning_usd == null || (can(tonumber(var.budget_warning_usd)) && tonumber(var.budget_warning_usd) > 0)
    error_message = "budget_warning_usd must be a positive number of dollars."
  }
  validation {
    condition     = var.budget_warning_usd == null || var.budget_limit_usd == null || tonumber(var.budget_warning_usd) < tonumber(var.budget_limit_usd)
    error_message = "budget_warning_usd must be below budget_limit_usd, or the first notice arrives no earlier than the last."
  }
}

variable "budget_cost_tag" {
  type        = string
  default     = ""
  description = "Set to Application to budget only this application's spending. Empty budgets the whole account, which only the personal rehearsal may do. AWS reports nothing against the filter until the Application tag is activated in Billing, so an unactivated tag makes the budget read zero rather than fail."
  validation {
    # Environment and ManagedBy are carried by work this budget does not pay
    # for, so neither can scope a project budget.
    condition     = contains(["", "Application"], var.budget_cost_tag)
    error_message = "budget_cost_tag must be Application, the one default tag that names this application, or empty for a whole-account budget."
  }
  validation {
    condition     = var.environment == "personal" || var.budget_cost_tag != ""
    error_message = "A shared account charges other people's work to an unfiltered budget, so a client budget must name its own cost-allocation tag."
  }
}
