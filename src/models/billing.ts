import { Schema, model } from "mongoose";
import { tenantPlugin, tenantIdField } from "../db/tenantPlugin.js";

/** One commission record per order. */
const commissionSchema = new Schema(
  {
    tenantId: tenantIdField,
    orderId: { type: Schema.Types.ObjectId, required: true },
    orderNumber: String,
    basePaise: Number, // order value the commission is calculated on
    ratePercent: Number,
    amountPaise: Number,
    status: { type: String, enum: ["accrued", "reversed", "billed"], default: "accrued", index: true },
    reversalReason: String,
    accruedAt: { type: Date, default: Date.now },
    statementId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);
commissionSchema.plugin(tenantPlugin);
commissionSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
commissionSchema.index({ tenantId: 1, accruedAt: 1 });
export const Commission = model("Commission", commissionSchema);

/** Monthly statement + GST invoice issued by the platform to the merchant. */
const statementSchema = new Schema(
  {
    tenantId: tenantIdField,
    period: { type: String, required: true }, // YYYY-MM
    invoiceNumber: { type: String, required: true },
    orderCount: Number,
    gmvPaise: Number,
    commissionPaise: Number,
    monthlyFeePaise: { type: Number, default: 0 },
    taxablePaise: Number,
    cgstPaise: Number,
    sgstPaise: Number,
    igstPaise: Number,
    totalPaise: Number,
    status: { type: String, enum: ["due", "paid", "overdue", "void"], default: "due", index: true },
    dueDate: Date,
    paidAt: Date,
    paymentRef: String,
    attempts: [{ at: Date, result: String, note: String }],
  },
  { timestamps: true },
);
statementSchema.plugin(tenantPlugin);
statementSchema.index({ tenantId: 1, period: 1 }, { unique: true });
export const Statement = model("Statement", statementSchema);

const adAccountSchema = new Schema(
  {
    tenantId: tenantIdField,
    platform: { type: String, enum: ["meta", "google"], required: true },
    accountId: String,
    accountName: String,
    status: { type: String, enum: ["connected", "disconnected"], default: "connected" },
  },
  { timestamps: true },
);
adAccountSchema.plugin(tenantPlugin);
export const AdAccount = model("AdAccount", adAccountSchema);

const campaignSchema = new Schema(
  {
    tenantId: tenantIdField,
    platform: { type: String, enum: ["meta", "google", "other"], required: true },
    name: { type: String, required: true },
    utmCampaign: { type: String, required: true }, // orders are matched to campaigns by utm_campaign
    status: { type: String, enum: ["draft", "active", "paused", "ended"], default: "active" },
    startDate: Date,
    endDate: Date,
    budgetPaise: Number,
    spend: [{ date: Date, amountPaise: Number, impressions: Number, clicks: Number }],
    notes: String,
  },
  { timestamps: true },
);
campaignSchema.plugin(tenantPlugin);
campaignSchema.index({ tenantId: 1, utmCampaign: 1 }, { unique: true });
export const Campaign = model("Campaign", campaignSchema);
