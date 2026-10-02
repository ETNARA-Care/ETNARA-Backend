import { Client } from "pg";

const PLATFORM_ADMIN_EMAIL=(process.env.PLATFORM_ADMIN_EMAIL??"admin@demo.etnara.care").trim().toLowerCase();
const databaseUrl=process.env.MIGRATIONS_DATABASE_URL??process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("Administrative database connection is required");

async function main(){
 const client=new Client({connectionString:databaseUrl});await client.connect();
 try{
  await client.query("BEGIN");
  const user=await client.query<{id:string}>(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`,[PLATFORM_ADMIN_EMAIL]);
  const userId=user.rows[0]?.id;if(!userId)throw new Error(`Platform admin user not found: ${PLATFORM_ADMIN_EMAIL}`);
  const authority=await client.query(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND revoked_at IS NULL`,[userId]);
  if(!authority.rows.length)throw new Error(`Active platform authority not found for ${PLATFORM_ADMIN_EMAIL}`);

  // Platform administrators are global identities, not tenant members.
  // Preserve membership history for auditability while revoking tenant access.
  await client.query(`UPDATE organization_memberships SET status='revoked', revoked_at=COALESCE(revoked_at, now()), updated_at=now() WHERE user_id=$1 AND status='active'`,[userId]);

  const active=await client.query(`SELECT 1 FROM organization_memberships WHERE user_id=$1 AND status='active' LIMIT 1`,[userId]);
  if(active.rows.length)throw new Error("Platform admin still has an active organization membership");
  await client.query("COMMIT");
  console.log(`ETNARA Plataforma desligada de organizaciones: ${PLATFORM_ADMIN_EMAIL}`);
 }catch(error){await client.query("ROLLBACK");throw error;}finally{await client.end();}
}
main().catch(error=>{console.error("Platform admin decoupling failed:",error);process.exit(1);});
