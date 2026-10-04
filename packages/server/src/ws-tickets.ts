import { randomBytes } from 'node:crypto';
export class WsTickets {
  private values=new Map<string,{device:number;expires:number}>();
  constructor(private now=()=>Date.now()){}
  issue(device:number):{ticket:string;expiresAt:number} {
    for(const [k,v] of this.values)if(v.expires<=this.now()||v.device===device)this.values.delete(k);
    const ticket=randomBytes(32).toString('base64url'),expiresAt=this.now()+60000;this.values.set(ticket,{device,expires:expiresAt});return {ticket,expiresAt};
  }
  consume(ticket:string):number|null {const value=this.values.get(ticket);this.values.delete(ticket);return value&&value.expires>this.now()?value.device:null;}
}
