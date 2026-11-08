import { NextResponse } from "next/server";
import { access, fail, ApiError, publicCharge } from "@/lib/api";
import { CHARGE_WITH_ITEMS, canAccessCharge } from "@/lib/catalog-validation";
import { z } from "zod";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { merchant, role, user, admin } = await access();
    if (!merchant) throw new ApiError(404, "Cobro no encontrado.");
    let query = admin.from("charges").select(CHARGE_WITH_ITEMS).eq("id", id).eq("merchant_id", merchant.id);
    if (role === "cashier") query = query.eq("created_by", user.id);
    const { data, error } = await query.maybeSingle();
    if (error) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!data || !canAccessCharge(role, user.id, data.created_by)) throw new ApiError(404, "Cobro no encontrado.");
    return NextResponse.json({ charge: publicCharge(data) });
  } catch (e) { return fail(e); }
}
