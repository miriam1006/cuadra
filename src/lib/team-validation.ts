import { z } from 'zod';
const email = z.string().trim().max(254).pipe(z.email()).transform(value => value.toLowerCase());
const displayName = z.string().trim().min(1).max(100);
const role = z.enum(['admin','cashier']);
export const newPasswordSchema = z.string().min(12,'Usa al menos 12 caracteres.').max(128);
export const teamCreateSchema = z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('create'),email,display_name:displayName,role,password:newPasswordSchema}),
  z.strictObject({mode:z.literal('existing'),email,display_name:displayName,role}),
]);
export const teamUpdateSchema = z.strictObject({display_name:displayName,role,active:z.boolean()});
export const passwordChangeSchema = z.strictObject({password:newPasswordSchema,confirm_password:newPasswordSchema})
  .refine(value=>value.password===value.confirm_password,{message:'Las contraseñas no coinciden.',path:['confirm_password']});
