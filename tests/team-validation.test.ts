import assert from 'node:assert/strict';
import test from 'node:test';
import {teamCreateSchema,teamUpdateSchema,passwordChangeSchema} from '../src/lib/team-validation';
const newUser={mode:'create',email:' Staff@Example.invalid ',display_name:' Cajera ',role:'cashier',password:'Temporary-test-pass-2026'};
test('team enrollment normalizes identity while role and password rules remain strict',()=>{
  const result=teamCreateSchema.parse(newUser);
  assert.equal(result.email,'staff@example.invalid');assert.equal(result.display_name,'Cajera');
  for(const patch of [{role:'owner'},{merchant_id:'other'},{user_id:'another'},{active:false},{app_metadata:{must_change_password:false}},{password:'short'},{email:'invalid'},{display_name:' '}]){
    assert.equal(teamCreateSchema.safeParse({...newUser,...patch}).success,false);
  }
});
test('linking an existing user cannot reset credentials through the same request',()=>{
  const link={mode:'existing',email:'staff@example.invalid',display_name:'Cajera',role:'cashier'};
  assert.equal(teamCreateSchema.safeParse(link).success,true);
  assert.equal(teamCreateSchema.safeParse({...link,password:'Never-reset-existing-pass'}).success,false);
});
test('membership update rejects hidden identity or tenant changes',()=>{
  const update={display_name:'Cajera',role:'cashier',active:false};
  assert.equal(teamUpdateSchema.safeParse(update).success,true);
  assert.equal(teamUpdateSchema.safeParse({...update,merchant_id:'other'}).success,false);
  assert.equal(teamUpdateSchema.safeParse({...update,email:'another@example.invalid'}).success,false);
});
test('first-login password change requires a matching sufficiently long confirmation',()=>{
  assert.equal(passwordChangeSchema.safeParse({password:'A-new-personal-password',confirm_password:'A-new-personal-password'}).success,true);
  assert.equal(passwordChangeSchema.safeParse({password:'A-new-personal-password',confirm_password:'Different-password'}).success,false);
  assert.equal(passwordChangeSchema.safeParse({password:'short',confirm_password:'short'}).success,false);
  assert.equal(passwordChangeSchema.safeParse({password:'A-new-personal-password',confirm_password:'A-new-personal-password',user_id:'other'}).success,false);
});
