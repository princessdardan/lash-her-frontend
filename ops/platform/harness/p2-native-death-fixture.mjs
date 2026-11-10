// Real process death test; backend is explicitly the protocol unit model.
import {nativeModel} from './p2-native-unit-fixture.mjs';
const fixture=nativeModel();
process.on('message',()=>{});
const toggle=fixture.input.nativeControl.setEnabled;
fixture.input.nativeControl.setEnabled=async(plan,enabled)=>{
  await toggle(plan,enabled);
  if(enabled){process.send({directory:fixture.input.directory,candidate:fixture.candidate,settings:fixture.settings,state:{epoch:fixture.state.epoch,newWork:fixture.state.newWork,recovery:fixture.state.recovery,enabled:fixture.state.enabled}});await new Promise(()=>{});}
};
fixture.run().catch(()=>{process.exitCode=1;});
