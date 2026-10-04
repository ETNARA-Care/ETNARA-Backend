import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const PLATFORM_ADMIN_EMAIL=(process.env.PLATFORM_ADMIN_EMAIL??"etnaracare@gmail.com").trim().toLowerCase();
const LEGACY_PLATFORM_ADMIN_EMAIL=(process.env.LEGACY_PLATFORM_ADMIN_EMAIL??"admin@demo.etnara.care").trim().toLowerCase();
const platformAdminPassword=process.env.PLATFORM_ADMIN_PASSWORD;
const databaseUrl=process.env.MIGRATIONS_DATABASE_URL??process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("Administrative database connection is required");
if(!platformAdminPassword)throw new Error("PLATFORM_ADMIN_PASSWORD is required for platform admin provisioning");
if(platformAdminPassword.length<12)throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 12 characters");

async function main(){
 const passwordHash=await hashPassword(platformAdminPassword);
 const client=new Client({connectionString:databaseUrl});await client.connect();
 try{
  await client.query("BEGIN");

  // The dedicated ETNARA Platform identity is global and intentionally has no tenant membership.
  const platformUser=await client.query<{id:string}>(`
    INSERT INTO users (email, status, password_hash)
    VALUES ($1, 'active', $2)
    ON CONFLICT (lower(email)) WHERE email IS NOT NULL
    DO UPDATE SET status='active', password_hash=EXCLUDED.password_hash, updated_at=now()
    RETURNING id
  `,[PLATFORM_ADMIN_EMAIL,passwordHash]);
  const platformUserId=platformUser.rows[0]?.id;
  if(!platformUserId)throw new Error(`Unable to provision platform admin user: ${PLATFORM_ADMIN_EMAIL}`);

  await client.query(`
    INSERT INTO platform_admins (user_id, granted_by_user_id)
    VALUES ($1,$1)
    ON CONFLICT (user_id) DO UPDATE SET revoked_at=NULL
  `,[platformUserId]);

  // Preserve membership history for auditability while ensuring the platform identity is not a tenant member.
  await client.query(`UPDATE organization_memberships SET status='revoked', revoked_at=COALESCE(revoked_at, now()), updated_at=now() WHERE user_id=$1 AND status='active'`,[platformUserId]);

  // The Casa Demo administrator remains a tenant administrator, but no longer has platform-wide authority.
  if(LEGACY_PLATFORM_ADMIN_EMAIL!==PLATFORM_ADMIN_EMAIL){
    const legacy=await client.query<{id:string}>(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`,[LEGACY_PLATFORM_ADMIN_EMAIL]);
    const legacyUserId=legacy.rows[0]?.id;
    if(legacyUserId){
      await client.query(`UPDATE platform_admins SET revoked_at=COALESCE(revoked_at, now()) WHERE user_id=$1 AND revoked_at IS NULL`,[legacyUserId]);
    }
  }

  const active=await client.query(`SELECT 1 FROM organization_memberships WHERE user_id=$1 AND status='active' LIMIT 1`,[platformUserId]);
  if(active.rows.length)throw new Error("Dedicated platform admin still has an active organization membership");
  const authority=await client.query(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND revoked_at IS NULL`,[platformUserId]);
  if(!authority.rows.length)throw new Error("Dedicated platform admin authority was not activated");

  await client.query("COMMIT");
  console.log(`ETNARA Plataforma conectada a cuenta dedicada: ${PLATFORM_ADMIN_EMAIL}`);
 }catch(error){await client.query("ROLLBACK");throw error;}finally{await client.end();}
}
main().catch(error=>{console.error("Platform admin provisioning failed:",error);process.exit(1);});
