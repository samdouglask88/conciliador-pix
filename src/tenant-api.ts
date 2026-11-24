export class ApiIssue extends Error {
  constructor(readonly status:number,message:string){super(message)}
}
export async function api<T>(path:string,body?:object):Promise<T>{
  let response:Response
  try {
    response=await fetch('/api/'+path,{
      method:body===undefined?'GET':'POST',
      credentials:'include',cache:'no-store',redirect:'error',
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json','X-ConciliaPix-CSRF':'1'},body:JSON.stringify(body)}),
    })
  }catch{throw new ApiIssue(0,'Não foi possível acessar o serviço. Tente novamente.')}
  if(response.status===204) return undefined as T
  if(!response.ok){
    const result=await response.json().catch(()=>null) as {message?:string}|null
    throw new ApiIssue(response.status,result?.message??'Não foi possível concluir a operação.')
  }
  return response.json() as Promise<T>
}
export function message(error:unknown){return error instanceof ApiIssue?error.message:'Não foi possível concluir a operação.'}
