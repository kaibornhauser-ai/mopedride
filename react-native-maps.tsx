import React,{forwardRef,useEffect,useImperativeHandle,useMemo} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MapContainer,TileLayer,Marker as LeafletMarker,Polyline as LeafletPolyline,useMap,useMapEvents} from 'react-leaflet';
import L from 'leaflet';

const regionToZoom=(r:any)=>{const d=Math.max(Number(r?.latitudeDelta||0.05),0.0001);return Math.max(2,Math.min(19,Math.round(Math.log2(360/d))))};
const center=(r:any)=>[Number(r?.latitude||48.137),Number(r?.longitude||11.575)] as [number,number];
const SAT='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const OSM='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
function InnerEvents({props}:{props:any}){const map=useMap();useMapEvents({click:e=>props.onPress?.({nativeEvent:{coordinate:{latitude:e.latlng.lat,longitude:e.latlng.lng}}}),dragstart:()=>props.onPanDrag?.(),drag:()=>props.onPanDrag?.(),zoom:()=>props.onPanDrag?.(),moveend:()=>{const c=map.getCenter();const b=map.getBounds();props.onRegionChangeComplete?.({latitude:c.lat,longitude:c.lng,latitudeDelta:Math.abs(b.getNorth()-b.getSouth()),longitudeDelta:Math.abs(b.getEast()-b.getWest())});}});return null}
function MapImperative({refObj}:{refObj:any}){const map=useMap();useImperativeHandle(refObj,()=>({animateToRegion:(r:any)=>map.flyTo(center(r),regionToZoom(r)),fitToCoordinates:(coords:any[])=>{if(coords?.length)map.fitBounds(coords.map(c=>[c.latitude,c.longitude] as [number,number]),{padding:[40,40]})},animateCamera:(c:any)=>{if(c?.center)map.flyTo([c.center.latitude,c.center.longitude],c.zoom||map.getZoom())},getCamera:async()=>{const c=map.getCenter();return {center:{latitude:c.lat,longitude:c.lng},zoom:map.getZoom()}}}),[map]);return null}
function findTile(node:any):string|undefined{let found:any;React.Children.forEach(node,(child:any)=>{if(!child||found)return;if(child.type===UrlTile)found=child.props?.urlTemplate;else if(child.props?.children)found=findTile(child.props.children)});return found}
const MapView=forwardRef<any,any>(function MapView({initialRegion,style,children,mapType,...props},ref){const tile=findTile(children);const url=tile||((mapType==='satellite'||mapType==='hybrid')?SAT:OSM);return <div style={style}><MapContainer center={center(initialRegion)} zoom={regionToZoom(initialRegion)} style={{width:'100%',height:'100%'}} scrollWheelZoom={true} doubleClickZoom={true} zoomControl={false}><TileLayer url={url}/><InnerEvents props={props}/><MapImperative refObj={ref}/>{children}</MapContainer></div>});
function Marker({coordinate,children,rotation=0}:any){const html=renderToStaticMarkup(<div style={{transform:`rotate(${rotation||0}deg)`,transformOrigin:'center center',display:'flex',alignItems:'center',justifyContent:'center'}}>{children}</div>);const icon=useMemo(()=>L.divIcon({className:'moped-marker',html,iconSize:[1,1],iconAnchor:[0,0]}),[html]);return <LeafletMarker position={[coordinate.latitude,coordinate.longitude]} icon={icon}/>}
function Polyline({coordinates,strokeColor,strokeWidth}:any){return <LeafletPolyline positions={coordinates.map((c:any)=>[c.latitude,c.longitude])} pathOptions={{color:strokeColor,weight:strokeWidth}}/>}
function UrlTile(_props:any){return null}
export {Marker,Polyline,UrlTile};
export type Region=any;
export default MapView;
