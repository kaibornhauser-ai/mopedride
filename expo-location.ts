export const Accuracy = { Balanced: 3, High: 6 } as const;
export type LocationSubscription = { remove: () => void };
export async function requestForegroundPermissionsAsync(){
  if (!navigator.geolocation) return { status:'denied', granted:false };
  return { status:'granted', granted:true };
}
export async function getCurrentPositionAsync(_opts?:any):Promise<any>{
  return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:10000,maximumAge:5000}));
}
export async function watchPositionAsync(opts:any, cb:(p:any)=>void):Promise<LocationSubscription>{
  const id=navigator.geolocation.watchPosition(cb,()=>{}, {enableHighAccuracy:true, timeout:10000, maximumAge:1000, distanceFilter:opts?.distanceInterval});
  return {remove:()=>navigator.geolocation.clearWatch(id)};
}
export async function watchHeadingAsync(_cb:any):Promise<LocationSubscription>{ return {remove:()=>{}}; }
