export type WidgetVirtualizationPolicy = "retain_state" | "restart_from_arguments";

/**
 * Transport shape for an artifact the consuming application has already
 * resolved from its reviewed catalog and integrity-verified.
 *
 * `integrity` is identity metadata; the browser host deliberately does not
 * fetch, sanitize, authorize, or verify artifact bytes. Never construct this
 * value directly from model output, user HTML, or an untrusted endpoint.
 */
export interface WidgetArtifact {
  schema_version: number;
  module_id: string;
  version: string;
  integrity: string;
  html: string;
  css: string;
}

export interface DataBindingReference {
  binding_id: string;
}

export interface WidgetInstancePlan {
  instance_id: string;
  widget_id: string;
  widget_version: string;
  arguments: Record<string, unknown>;
  data_binding?: DataBindingReference;
  placement: {
    region: "next" | "primary" | "secondary" | "overlay";
    priority: number;
  };
  persistence: "ephemeral" | "pinned";
}

export interface CanvasPlan {
  schema_version: number;
  request_id: string;
  disposition: "mount" | "clarify" | "abstain";
  instances: WidgetInstancePlan[];
  clarification?: string | null;
  explanation: string;
}
