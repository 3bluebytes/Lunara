import { asyncRoute, okPayload, requireService } from './routeUtils.js';
import { localRequestAllowed } from '../requestBoundary.js';
export function registerWebAccessRoutes(app, {webAccess} = {}) {
  const guard=(req,res)=>{
    if(!localRequestAllowed(req.headers).ok){res.status(403).json({ok:false,error:'不允许的请求来源。'});return false;}
    return requireService(res,webAccess,'web access');
  };
  app.get('/api/web-access/settings',(req,res)=>{
    if(guard(req,res))res.json(okPayload(webAccess.policy.snapshot()));
  });
  app.patch('/api/web-access/settings',asyncRoute(async(req,res)=>{
    if(guard(req,res))res.json(okPayload(webAccess.policy.update(req.body)));
  }));
}
