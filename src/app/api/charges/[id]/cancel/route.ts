import { NextResponse } from "next/server";
import { access, fail, sameOrigin, ApiError, publicCharge } from "@/lib/api";
import { CHARGE_WITH_ITEMS, catalogRpcFailure, canAccessCharge } from "@/lib/catalog-validation";
import { z } from "zod";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { user, merchant, role, admin } = await access();
    if (!merchant) throw new ApiError(404, "Cobro no encontrado.");
    const scoped = () => {
      let query = admin.from("charges").select(CHARGE_WITH_ITEMS).eq("id", id).eq("merchant_id", merchant.id);
      if (role === "cashier") query = query.eq("created_by", user.id);
      return query;
    };
    const { data: existing, error: readError } = await scoped().maybeSingle();
    if (readError) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!existing || !canAccessCharge(role, user.id, existing.created_by)) throw new ApiError(404, "Cobro no encontrado.");
    const { error } = await admin.rpc("cancel_charge", { p_charge_id: id, p_owner_user_id: user.id });
    if (error) { const failure = catalogRpcFailure(error); throw new ApiError(failure.status, failure.message); }
    const { data: updated, error: refreshError } = await scoped().single();
    if (refreshError || !updated) throw new ApiError(503, "No se pudo consultar el resultado. Revisa el historial.");
    return NextResponse.json({ charge: publicCharge(updated) });
  } catch (e) { return fail(e); }
}
